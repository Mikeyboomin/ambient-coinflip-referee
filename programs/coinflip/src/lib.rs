use anchor_lang::prelude::*;
use sha2::{Digest, Sha256};

declare_id!("61LZE86MZSN8vKj9fXStz3LXnFkhkBXy6LNUBaPSAJdi"); // Anchor will update this on deploy

#[program]
pub mod coinflip {
    use super::*;

    pub fn create_game(
        ctx: Context<CreateGame>,
        stake_lamports: u64,
        commit_a: [u8; 32],
        reveal_deadline_slots: u64,
    ) -> Result<()> {
        require!(stake_lamports > 0, CoinflipError::InvalidStake);

        let game = &mut ctx.accounts.game;
        game.creator = ctx.accounts.creator.key();
        game.joiner = Pubkey::default();
        game.stake_lamports = stake_lamports;

        game.commit_a = commit_a;
        game.commit_b = [0u8; 32];

        game.revealed_a = false;
        game.revealed_b = false;

        game.choice_a = 0;
        game.choice_b = 0;
        game.secret_a = [0u8; 32];
        game.secret_b = [0u8; 32];

        let now_slot = Clock::get()?.slot;
        game.created_slot = now_slot;
        game.reveal_deadline_slot = now_slot.saturating_add(reveal_deadline_slots);

        game.coin = 0;
        game.winner = Pubkey::default();
        game.status = GameStatus::Created;

        // move creator stake into vault
        deposit_to_vault(
    &ctx.accounts.creator,
    &ctx.accounts.vault,
    &ctx.accounts.system_program,
    stake_lamports,
)?;


        Ok(())
    }

    pub fn join_game(ctx: Context<JoinGame>, commit_b: [u8; 32]) -> Result<()> {
        let game = &mut ctx.accounts.game;
        require!(game.status == GameStatus::Created, CoinflipError::BadStatus);
        require!(game.joiner == Pubkey::default(), CoinflipError::AlreadyJoined);

        game.joiner = ctx.accounts.joiner.key();
        game.commit_b = commit_b;
        game.status = GameStatus::Joined;

        deposit_to_vault(
    &ctx.accounts.joiner,
    &ctx.accounts.vault,
    &ctx.accounts.system_program,
    game.stake_lamports,
)?;

        Ok(())
    }

    pub fn reveal_creator(ctx: Context<Reveal>, choice: u8, secret: [u8; 32]) -> Result<()> {
        let game = &mut ctx.accounts.game;
        require!(
            game.status == GameStatus::Joined || game.status == GameStatus::Revealing,
            CoinflipError::BadStatus
        );
        require!(ctx.accounts.signer.key() == game.creator, CoinflipError::NotPlayer);
        require!(choice <= 1, CoinflipError::InvalidChoice);
        require!(!game.revealed_a, CoinflipError::AlreadyRevealed);

        let expected = commit_hash(choice, &secret);
        require!(expected == game.commit_a, CoinflipError::BadReveal);

        game.choice_a = choice;
        game.secret_a = secret;
        game.revealed_a = true;
        game.status = GameStatus::Revealing;

        if game.revealed_b {
            compute_outcome(game)?;
            game.status = GameStatus::ReadyToFinalize;
        }

        Ok(())
    }

    pub fn reveal_joiner(ctx: Context<Reveal>, choice: u8, secret: [u8; 32]) -> Result<()> {
        let game = &mut ctx.accounts.game;
        require!(
            game.status == GameStatus::Joined || game.status == GameStatus::Revealing,
            CoinflipError::BadStatus
        );
        require!(ctx.accounts.signer.key() == game.joiner, CoinflipError::NotPlayer);
        require!(choice <= 1, CoinflipError::InvalidChoice);
        require!(!game.revealed_b, CoinflipError::AlreadyRevealed);

        let expected = commit_hash(choice, &secret);
        require!(expected == game.commit_b, CoinflipError::BadReveal);

        game.choice_b = choice;
        game.secret_b = secret;
        game.revealed_b = true;
        game.status = GameStatus::Revealing;

        if game.revealed_a {
            compute_outcome(game)?;
            game.status = GameStatus::ReadyToFinalize;
        }

        Ok(())
    }

    pub fn forfeit_if_timeout(ctx: Context<ForfeitIfTimeout>) -> Result<()> {
        let game = &mut ctx.accounts.game;
        require!(
            game.status == GameStatus::Joined || game.status == GameStatus::Revealing,
            CoinflipError::BadStatus
        );

        let now = Clock::get()?.slot;
        require!(now >= game.reveal_deadline_slot, CoinflipError::TooEarly);
        require!(game.joiner != Pubkey::default(), CoinflipError::NotReady);

        let total = game.stake_lamports.saturating_mul(2);

        if game.revealed_a && !game.revealed_b {
            payout(
                &ctx.accounts.vault.to_account_info(),
                &ctx.accounts.creator_payout.to_account_info(),
                total,
            )?;
            game.winner = game.creator;
            game.status = GameStatus::Finalized;
        } else if game.revealed_b && !game.revealed_a {
            payout(
                &ctx.accounts.vault.to_account_info(),
                &ctx.accounts.joiner_payout.to_account_info(),
                total,
            )?;
            game.winner = game.joiner;
            game.status = GameStatus::Finalized;
        } else {
            // refund both if neither revealed
            payout(
                &ctx.accounts.vault.to_account_info(),
                &ctx.accounts.creator_payout.to_account_info(),
                game.stake_lamports,
            )?;
            payout(
                &ctx.accounts.vault.to_account_info(),
                &ctx.accounts.joiner_payout.to_account_info(),
                game.stake_lamports,
            )?;
            game.status = GameStatus::Finalized;
        }

        Ok(())
    }

    pub fn finalize(ctx: Context<Finalize>) -> Result<()> {
        let game = &mut ctx.accounts.game;
        require!(game.status == GameStatus::ReadyToFinalize, CoinflipError::BadStatus);

        let total = game.stake_lamports.saturating_mul(2);

        if game.winner == game.creator {
            payout(
                &ctx.accounts.vault.to_account_info(),
                &ctx.accounts.creator_payout.to_account_info(),
                total,
            )?;
        } else if game.winner == game.joiner {
            payout(
                &ctx.accounts.vault.to_account_info(),
                &ctx.accounts.joiner_payout.to_account_info(),
                total,
            )?;
        } else {
            return err!(CoinflipError::NotReady);
        }

        game.status = GameStatus::Finalized;
        Ok(())
    }
}

#[account]
pub struct Game {
    pub creator: Pubkey,
    pub joiner: Pubkey,
    pub stake_lamports: u64,

    pub commit_a: [u8; 32],
    pub commit_b: [u8; 32],

    pub revealed_a: bool,
    pub revealed_b: bool,

    pub choice_a: u8,
    pub choice_b: u8,

    pub secret_a: [u8; 32],
    pub secret_b: [u8; 32],

    pub created_slot: u64,
    pub reveal_deadline_slot: u64,

    pub coin: u8, // 0 or 1
    pub winner: Pubkey,

    pub status: GameStatus,
}

impl Game {
    pub const SPACE: usize =
        8 + // discriminator
        32 + 32 + // creator, joiner
        8 + // stake
        32 + 32 + // commits
        1 + 1 + // revealed flags
        1 + 1 + // choices
        32 + 32 + // secrets
        8 + 8 + // slots
        1 + 32 + // coin, winner
        1; // status enum as u8
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum GameStatus {
    Created = 0,
    Joined = 1,
    Revealing = 2,
    ReadyToFinalize = 3,
    Finalized = 4,
}

#[derive(Accounts)]
pub struct CreateGame<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    /// CHECK: This account's key is used only as a seed to make the PDA unique.
    pub game_seed: UncheckedAccount<'info>,

    #[account(
        init,
        payer = creator,
        space = Game::SPACE,
        seeds = [b"game", creator.key().as_ref(), game_seed.key().as_ref()],
        bump
    )]
    pub game: Account<'info, Game>,

    #[account(
        init,
        payer = creator,
        space = 8, 
        seeds = [b"vault", game.key().as_ref()],
        bump
    )]
    /// CHECK: This is an escrow account for lamports; we manually manage its balance.
    pub vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinGame<'info> {
    #[account(mut)]
    pub joiner: Signer<'info>,

    #[account(mut)]
    pub game: Account<'info, Game>,

    #[account(
        mut,
        seeds = [b"vault", game.key().as_ref()],
        bump
    )]
    /// CHECK: This is an escrow account for lamports.
    pub vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Reveal<'info> {
    pub signer: Signer<'info>,
    #[account(mut)]
    pub game: Account<'info, Game>,
}

#[derive(Accounts)]
pub struct ForfeitIfTimeout<'info> {
    #[account(mut)]
    pub game: Account<'info, Game>,

    #[account(
        mut,
        seeds = [b"vault", game.key().as_ref()],
        bump
    )]
    /// CHECK: Escrow account for lamports.
    pub vault: UncheckedAccount<'info>,

    /// CHECK: Signer's payout address
    #[account(mut)]
    pub creator_payout: UncheckedAccount<'info>,
    /// CHECK: Joiner's payout address
    #[account(mut)]
    pub joiner_payout: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Finalize<'info> {
    #[account(mut)]
    pub game: Account<'info, Game>,

    #[account(
        mut,
        seeds = [b"vault", game.key().as_ref()],
        bump
    )]
    /// CHECK: Escrow account for lamports.
    pub vault: UncheckedAccount<'info>,

    /// CHECK: Creator's payout address
    #[account(mut)]
    pub creator_payout: UncheckedAccount<'info>,
    /// CHECK: Joiner's payout address
    #[account(mut)]
    pub joiner_payout: UncheckedAccount<'info>,
}

#[error_code]
pub enum CoinflipError {
    #[msg("Invalid stake amount")]
    InvalidStake,
    #[msg("Game is in the wrong status for this action")]
    BadStatus,
    #[msg("Game already has a joiner")]
    AlreadyJoined,
    #[msg("Signer is not a player")]
    NotPlayer,
    #[msg("Choice must be 0 or 1")]
    InvalidChoice,
    #[msg("Reveal does not match commitment")]
    BadReveal,
    #[msg("Already revealed")]
    AlreadyRevealed,
    #[msg("Too early to forfeit")]
    TooEarly,
    #[msg("Not ready")]
    NotReady,
}

fn commit_hash(choice: u8, secret: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update([choice]);
    hasher.update(secret);
    hasher.finalize().into()
}

fn compute_outcome(game: &mut Account<Game>) -> Result<()> {
    let mut hasher = Sha256::new();
    hasher.update(game.secret_a);
    hasher.update(game.secret_b);
    hasher.update(game.key().as_ref());
    let h: [u8; 32] = hasher.finalize().into();

    game.coin = (h[0] % 2) as u8;

    if game.choice_a == game.coin {
        game.winner = game.creator;
    } else {
        game.winner = game.joiner;
    }

    Ok(())
}

fn transfer_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    **from.try_borrow_mut_lamports()? = from
        .lamports()
        .checked_sub(amount)
        .ok_or(CoinflipError::InvalidStake)?;
    **to.try_borrow_mut_lamports()? = to
        .lamports()
        .checked_add(amount)
        .ok_or(CoinflipError::InvalidStake)?;
    Ok(())
}

fn payout(vault: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    **vault.try_borrow_mut_lamports()? = vault
        .lamports()
        .checked_sub(amount)
        .ok_or(CoinflipError::InvalidStake)?;
    **to.try_borrow_mut_lamports()? = to
        .lamports()
        .checked_add(amount)
        .ok_or(CoinflipError::InvalidStake)?;
    Ok(())
}

use anchor_lang::system_program;

fn deposit_to_vault<'info>(
    from: &Signer<'info>,
    vault: &UncheckedAccount<'info>,
    system_program: &Program<'info, System>,
    amount: u64,
) -> Result<()> {
    let cpi_accounts = system_program::Transfer {
        from: from.to_account_info(),
        to: vault.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(system_program.to_account_info(), cpi_accounts);
    system_program::transfer(cpi_ctx, amount)
}
