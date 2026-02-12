AI-Refereed On-Chain Coinflip (Solana + Anchor + Ambient Tool Oracle)

A commit–reveal coinflip smart contract on Solana where an AI oracle verifies fairness and publishes a deterministic verdict (VALID or CHEAT) on-chain.

Architecture Overview
1️) Game Flow (On-Chain)

Creator commits: commitA = sha256(choiceA || secretA)

Joiner commits: commitB = sha256(choiceB || secretB)

Both reveal secrets

Coin result:

coin = sha256(secretA || secretB || game_pubkey)[0] % 2


Winner determined deterministically

Funds distributed via program logic

2️) AI Oracle Referee

After finalization:

A Tool Oracle request is created

AI verifies:

Commit integrity

Reveal correctness

Deterministic coin computation

Winner correctness

Regex filter ensures output is strictly:

VALID | CHEAT


The verdict is written back on-chain.

Tech Stack

Rust + Anchor (Smart Contract)

Solana PDAs

Manual Borsh Encoding

JavaScript (Node.js client scripts)

Ambient Tool Oracle

Commit–Reveal Cryptography

Repository Structure
programs/coinflip/       → Anchor smart contract
scripts/demo.js          → Full coinflip flow
scripts/referee.js       → Oracle integration
scripts/run_all.sh       → End-to-end demo
idls/tool_oracle.json    → Oracle IDL

Run Full Demo
./scripts/run_all.sh


Flow:

Deploy game

Execute commit/reveal

Finalize payout

Submit oracle request

Poll verdict

Example output:

VERDICT: VALID

Security Model

Commit–reveal prevents front-running

Deterministic coin derivation

On-chain state validation

Oracle output filtered via strict regex

Escrow-based oracle payment

Why This Matters

Most Web3 games rely purely on contract logic.

This project demonstrates a hybrid model:

Deterministic on-chain computation

AI-based secondary verification

Cryptographically auditable fairness

It explores how AI and smart contracts can interoperate securely.
