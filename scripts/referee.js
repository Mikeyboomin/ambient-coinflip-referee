const fs = require("fs");
const crypto = require("crypto");
const anchor = require("@coral-xyz/anchor");
const { PublicKey, SystemProgram, Transaction, TransactionInstruction, Keypair } = require("@solana/web3.js");

const ORACLE_PROGRAM_ID = new PublicKey("721QWDeUzVL77UCzCFHsVGCMBVup8GsAMPaD2YvWvw97");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const loadJson = (path) => JSON.parse(fs.readFileSync(path, "utf8"));

const u8 = (n) => Buffer.from([n & 0xff]);
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n), 0); return b; };
const str = (s) => { const b = Buffer.from(s, "utf8"); return Buffer.concat([u32le(b.length), b]); };

function ixDiscriminator(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

async function main() {
  // --- HARDCODED FOR DEMO RECORDING ---
  const connection = new anchor.web3.Connection("https://rpc.ambient.xyz", "confirmed");
  const secretKey = JSON.parse(fs.readFileSync("./demo_wallet.json", "utf-8"));
  const demoKeypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));
  const wallet = new anchor.Wallet(demoKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { preflightCommitment: "confirmed" });
  
  const payer = demoKeypair.publicKey;
  const round = loadJson("artifacts/round.json");

  // Derive PDAs - These will be brand new because 'payer' is the Demo Wallet
  const [requestPda] = PublicKey.findProgramAddressSync([Buffer.from("tool-oracle-request"), payer.toBuffer()], ORACLE_PROGRAM_ID);
  const [outputPda] = PublicKey.findProgramAddressSync([Buffer.from("tool-oracle-output"), payer.toBuffer()], ORACLE_PROGRAM_ID);

  console.log("=== AMBIENT TOOL ORACLE REFEREE ===");
  console.log("Payer Wallet (DEMO):", payer.toBase58());

  // Create Request
  console.log("Submitting Oracle Request...");
  const promptText = `Verify Coinflip Game ${round.game.slice(0,8)}: Result ${round.coin}, Winner ${round.winner.slice(0,8)}. Respond VALID or CHEAT.`;

  const ixData = Buffer.concat([
    ixDiscriminator("create_request"),
    u8(0), 
    Buffer.concat([u8(0), Buffer.concat([u8(1), str(promptText)]), u8(1), Buffer.concat([u8(1), str("^(VALID|CHEAT)$")])]),
    u64le(1000000)
  ]);

  const tx = await provider.sendAndConfirm(new Transaction().add(new TransactionInstruction({
    programId: ORACLE_PROGRAM_ID,
    keys: [
      { pubkey: requestPda, isSigner: false, isWritable: true },
      { pubkey: outputPda, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: ixData
  })));

  console.log("✅ Request Created:", tx);

  // Polling
  console.log("Waiting for Oracle verdict...");
  let verdict = null;
  while (!verdict) {
    const acc = await provider.connection.getAccountInfo(outputPda);
    if (acc) {
      const text = acc.data.toString('utf8');
      if (text.includes("VALID")) verdict = "VALID";
      else if (text.includes("CHEAT")) verdict = "CHEAT";
    }
    if (!verdict) { process.stdout.write("."); await sleep(4000); }
  }

  console.log(`\n[VERDICT]: ${verdict}`);
  fs.writeFileSync("artifacts/referee.json", JSON.stringify({ tx, verdict, round }, null, 2));
}

main().catch(console.error);