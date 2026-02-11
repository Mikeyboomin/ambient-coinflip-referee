const anchor = require("@coral-xyz/anchor");
const { PublicKey, SystemProgram, Transaction, TransactionInstruction } = require("@solana/web3.js");
const crypto = require("crypto");

const ORACLE_PROGRAM_ID = new PublicKey("721QWDeUzVL77UCzCFHsVGCMBVup8GsAMPaD2YvWvw97");

function ixDiscriminator(ixName) {
  const h = crypto.createHash("sha256").update(`global:${ixName}`).digest();
  return h.subarray(0, 8);
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  const connection = provider.connection;
  const payer = provider.wallet.publicKey;

  const [requestPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("tool-oracle-request"), payer.toBuffer()],
    ORACLE_PROGRAM_ID
  );

  console.log("=== TOOL ORACLE: MANUAL RECLAIM ===");
  const accInfo = await connection.getAccountInfo(requestPda);
  if (!accInfo) {
    console.log("PDA already empty. Ready to go.");
    return;
  }

  // Manual IX building to bypass Anchor's .size bug
  const data = ixDiscriminator("reclaim_accounts");
  
  const ix = new TransactionInstruction({
    programId: ORACLE_PROGRAM_ID,
    keys: [
      { pubkey: requestPda, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: false, isWritable: true }, // destination
      { pubkey: payer, isSigner: true, isWritable: true },  // signer
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  const sig = await provider.sendAndConfirm(tx, [], { commitment: "confirmed" });
  console.log("Reclaim Success! Sig:", sig);
}

main().catch(console.error);