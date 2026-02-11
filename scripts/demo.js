// scripts/demo.js
//
// End-to-end coinflip round on Ambient:
// - create_game -> join_game -> reveal_creator -> reveal_joiner -> finalize
// - prints tx signatures + outcome
// - writes artifacts/round.json (evidence bundle for your Week 4 write-up / oracle referee)
//
// Run from project root:
//   export ANCHOR_PROVIDER_URL="https://rpc.ambient.xyz"
//   export ANCHOR_WALLET="$HOME/.config/solana/id.json"
//   node scripts/demo.js
//
// If Ambient airdrop is not supported, fund the joiner manually when the script prints its pubkey:
//   solana transfer <JOINER_PUBKEY> 0.2 --allow-unfunded-recipient --url https://rpc.ambient.xyz

const anchor = require("@coral-xyz/anchor");
const crypto = require("crypto");
const fs = require("fs");

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest();
}

// commit = sha256(choice || secret)
function commit(choice, secret32) {
  return sha256(Buffer.concat([Buffer.from([choice]), secret32]));
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getSol(connection, pubkey) {
  const lamports = await connection.getBalance(pubkey, "confirmed");
  return lamports / anchor.web3.LAMPORTS_PER_SOL;
}

async function ensureDir(path) {
  if (!fs.existsSync(path)) fs.mkdirSync(path, { recursive: true });
}

// Best-effort funding helper.
// Ambient may not support airdrop; if it fails, we'll tell you to transfer manually.
async function tryAirdrop(connection, pubkey, sol = 0.2) {
  try {
    const sig = await connection.requestAirdrop(
      pubkey,
      Math.ceil(sol * anchor.web3.LAMPORTS_PER_SOL)
    );
    await connection.confirmTransaction(sig, "confirmed");
    return { ok: true, sig };
  } catch (e) {
    return { ok: false, error: e };
  }
}

async function main() {
  // Provider from env vars (ANCHOR_PROVIDER_URL / ANCHOR_WALLET)
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Coinflip;
  const connection = provider.connection;

  // Players
  const creator = provider.wallet.publicKey;
  const joinerPath = process.env.JOINER_KEYPAIR || `${process.env.HOME}/.config/solana/joiner.json`;
const joiner = anchor.web3.Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(joinerPath, "utf8")))
);


  // Config
  const stakeSol = 0.05;
  const stakeLamports = new anchor.BN(Math.floor(stakeSol * anchor.web3.LAMPORTS_PER_SOL));
  const revealDeadlineSlots = new anchor.BN(500);

  // Secrets + choices (change these if you want)
  const secretA = crypto.randomBytes(32);
  const secretB = crypto.randomBytes(32);
  const choiceA = 0; // heads
  const choiceB = 1; // tails
  const commitA = commit(choiceA, secretA);
  const commitB = commit(choiceB, secretB);

  // PDA derivation seed
  const gameSeed = anchor.web3.Keypair.generate().publicKey;

  // Derive PDAs
  const [gamePda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("game"), creator.toBuffer(), gameSeed.toBuffer()],
    program.programId
  );
  const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), gamePda.toBuffer()],
    program.programId
  );

  console.log("=== COINFLIP DEMO (AMBIENT) ===");
  console.log("rpc     :", connection.rpcEndpoint);
  console.log("program :", program.programId.toBase58());
  console.log("creator :", creator.toBase58());
  console.log("joiner  :", joiner.publicKey.toBase58());
  console.log("game    :", gamePda.toBase58());
  console.log("vault   :", vaultPda.toBase58());
  console.log("stake   :", stakeSol, "SOL");
  console.log("");

  // Basic balance info
  const creatorSol0 = await getSol(connection, creator);
  const joinerSol0 = await getSol(connection, joiner.publicKey);
  console.log("creator balance (start):", creatorSol0);
  console.log("joiner  balance (start):", joinerSol0);

  // Try to fund joiner (may fail on Ambient)
  if (joinerSol0 < 0.1) {
    console.log("\nFunding joiner...");
    const airdrop = await tryAirdrop(connection, joiner.publicKey, 0.2);
    if (!airdrop.ok) {
      console.log("Airdrop failed (this is common). Fund joiner manually, then rerun:");
      console.log(
        `  solana transfer ${joiner.publicKey.toBase58()} 0.2 --allow-unfunded-recipient --url https://rpc.ambient.xyz`
      );
      console.log("\nAirdrop error:", airdrop.error?.message || airdrop.error);
      process.exit(1);
    }
    console.log("Airdrop tx:", airdrop.sig);
    await sleep(800);
  }

  // Re-check joiner balance
  const joinerSol1 = await getSol(connection, joiner.publicKey);
  console.log("joiner balance (funded):", joinerSol1);
  console.log("");

  // Collect tx signatures
  const txs = {};

  // 1) create_game
  console.log("1) create_game...");
  txs.create = await program.methods
    .createGame(stakeLamports, [...commitA], revealDeadlineSlots)
    .accounts({
      creator,
      gameSeed,
      game: gamePda,
      vault: vaultPda,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc({ commitment: "confirmed" });
  console.log("   tx:", txs.create);

  // 2) join_game
  console.log("2) join_game...");
  txs.join = await program.methods
    .joinGame([...commitB])
    .accounts({
      joiner: joiner.publicKey,
      game: gamePda,
      vault: vaultPda,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([joiner])
    .rpc({ commitment: "confirmed" });
  console.log("   tx:", txs.join);

  // 3) reveal_creator
  console.log("3) reveal_creator...");
  txs.revealA = await program.methods
    .revealCreator(choiceA, [...secretA])
    .accounts({
      signer: creator,
      game: gamePda,
    })
    .rpc({ commitment: "confirmed" });
  console.log("   tx:", txs.revealA);

  // 4) reveal_joiner
  console.log("4) reveal_joiner...");
  txs.revealB = await program.methods
    .revealJoiner(choiceB, [...secretB])
    .accounts({
      signer: joiner.publicKey,
      game: gamePda,
    })
    .signers([joiner])
    .rpc({ commitment: "confirmed" });
  console.log("   tx:", txs.revealB);

  // Fetch game state
  const game = await program.account.game.fetch(gamePda, "confirmed");

  console.log("\n=== RESULT (pre-finalize) ===");
  console.log("coin   :", game.coin); // 0 or 1
  console.log("winner :", game.winner.toBase58());
  console.log("");

  // 5) finalize
  console.log("5) finalize...");
  txs.finalize = await program.methods
    .finalize()
    .accounts({
      game: gamePda,
      vault: vaultPda,
      creatorPayout: creator,
      joinerPayout: joiner.publicKey,
    })
    .rpc({ commitment: "confirmed" });
  console.log("   tx:", txs.finalize);

  // Balances after
  const creatorSol2 = await getSol(connection, creator);
  const joinerSol2 = await getSol(connection, joiner.publicKey);

  console.log("\n=== BALANCES (end) ===");
  console.log("creator balance:", creatorSol2, "Δ", creatorSol2 - creatorSol0);
  console.log("joiner  balance:", joinerSol2, "Δ", joinerSol2 - joinerSol1);

  // Evidence bundle for write-up / oracle referee step
  await ensureDir("artifacts");
  const evidence = {
    rpc: connection.rpcEndpoint,
    programId: program.programId.toBase58(),
    creator: creator.toBase58(),
    joiner: joiner.publicKey.toBase58(),
    game: gamePda.toBase58(),
    vault: vaultPda.toBase58(),
    stakeSol,
    stakeLamports: stakeLamports.toString(),
    revealDeadlineSlots: revealDeadlineSlots.toString(),
    commitA_hex: Buffer.from(commitA).toString("hex"),
    commitB_hex: Buffer.from(commitB).toString("hex"),
    choiceA,
    choiceB,
    secretA_hex: Buffer.from(secretA).toString("hex"),
    secretB_hex: Buffer.from(secretB).toString("hex"),
    coin: game.coin,
    winner: game.winner.toBase58(),
    txs,
    timestamp: new Date().toISOString(),
  };

  fs.writeFileSync("artifacts/round.json", JSON.stringify(evidence, null, 2));
  console.log("\nwrote artifacts/round.json");

  console.log("\nDone.");
}

main().catch((e) => {
  console.error("\nERROR:");
  console.error(e);
  process.exit(1);
});
