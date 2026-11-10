use anyhow::{bail, ensure, Context, Result};
use near_estate_contract::{
    BuildingType, GameConfig, NPCSite, NPCSiteSeed, Plot, PlotSeed, PlotView, RoadId, ServiceRole,
    Side,
};
use near_sdk::serde_json::{json, Value};
use near_workspaces::{types::NearToken, Account, AccountId, ContractState};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CitySeed {
    version: u32,
    streets: Vec<Value>,
    plots: Vec<SeedPlot>,
    npc_sites: Vec<SeedNpc>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeedPlot {
    id: String,
    road_id: RoadId,
    side: Side,
    index: u8,
    corner: bool,
    initial_type: BuildingType,
    initial_variant: u8,
}

impl SeedPlot {
    fn contract_seed(&self) -> PlotSeed {
        PlotSeed {
            road_id: self.road_id,
            side: self.side,
            index: self.index,
            building_type: self.initial_type,
            variant: self.initial_variant,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeedNpc {
    id: String,
    road_id: RoadId,
    side: Side,
    frontage_index: u8,
    role: ServiceRole,
    name: String,
    capacity: u8,
}

impl SeedNpc {
    fn contract_seed(&self) -> NPCSiteSeed {
        NPCSiteSeed {
            id: self.id.clone(),
            road_id: self.road_id,
            side: self.side,
            frontage_index: self.frontage_index,
            role: self.role,
            name: self.name.clone(),
            capacity: self.capacity,
        }
    }
}

fn estate_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn load_seed(path: &Path) -> Result<CitySeed> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let seed: CitySeed = near_sdk::serde_json::from_slice(&bytes)
        .with_context(|| format!("parsing {}", path.display()))?;
    ensure!(seed.version == 1, "expected city seed version 1");
    ensure!(seed.streets.len() == 5, "expected five roads");
    ensure!(seed.plots.len() == 80, "expected 80 player plots");
    ensure!(seed.npc_sites.len() == 7, "expected seven NPC sites");
    let mut ids = HashSet::new();
    for plot in &seed.plots {
        ensure!(
            plot.id == plot.contract_seed().id(),
            "plot ID does not match its coordinates: {}",
            plot.id
        );
        ensure!(
            plot.corner == (plot.index == 0 || plot.index == 7),
            "corner flag mismatch: {}",
            plot.id
        );
        ensure!(ids.insert(&plot.id), "duplicate plot ID: {}", plot.id);
    }
    let tower_count = seed
        .npc_sites
        .iter()
        .filter(|site| site.role == ServiceRole::ParkingTower)
        .count();
    ensure!(tower_count == 3, "expected three parking towers");
    for site in &seed.npc_sites {
        ensure!(ids.insert(&site.id), "duplicate NPC ID: {}", site.id);
        ensure!(
            (site.role == ServiceRole::ParkingTower && site.capacity == 32)
                || (site.role != ServiceRole::ParkingTower && site.capacity == 0),
            "NPC capacity mismatch: {}",
            site.id
        );
    }
    Ok(seed)
}

fn wasm_path() -> PathBuf {
    std::env::var_os("ESTATE_WASM")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            estate_root().join("target/wasm32-unknown-unknown/release/near_estate_contract.wasm")
        })
}

fn required_env(name: &str) -> Result<String> {
    let value = std::env::var(name).with_context(|| format!("{name} is required for --apply"))?;
    ensure!(!value.trim().is_empty(), "{name} must not be empty");
    Ok(value)
}

fn code_sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

async fn plot_view(deployer: &Account, id: &str) -> Result<Option<PlotView>> {
    Ok(deployer
        .view(deployer.id(), "get_plot")
        .args_json(json!({"plot_id": id}))
        .await?
        .json()?)
}

async fn npc_view(deployer: &Account, id: &str) -> Result<Option<NPCSite>> {
    Ok(deployer
        .view(deployer.id(), "get_npc_site")
        .args_json(json!({"site_id": id}))
        .await?
        .json()?)
}

fn verify_plot(existing: &Plot, expected: &SeedPlot) -> Result<()> {
    ensure!(
        existing.id == expected.id
            && existing.road_id == expected.road_id
            && existing.side == expected.side
            && existing.index == expected.index
            && existing.corner == expected.corner,
        "on-chain plot conflicts with seed: {}",
        expected.id
    );
    Ok(())
}

fn verify_npc(existing: &NPCSite, expected: &SeedNpc) -> Result<()> {
    ensure!(
        existing.id == expected.id
            && existing.road_id == expected.road_id
            && existing.side == expected.side
            && existing.frontage_index == expected.frontage_index
            && existing.role == expected.role
            && existing.name == expected.name
            && existing.capacity == expected.capacity,
        "on-chain NPC site conflicts with seed: {}",
        expected.id
    );
    Ok(())
}

async fn seed_city(deployer: &Account, seed: &CitySeed) -> Result<()> {
    let contract_id = deployer.id();
    // Read and validate every existing record before making the first seed write.
    let mut missing_plots = Vec::new();
    for plot in &seed.plots {
        match plot_view(&deployer, &plot.id).await? {
            Some(existing) => verify_plot(&existing.plot, plot)?,
            None => missing_plots.push(plot),
        }
    }
    let mut missing_sites = Vec::new();
    for site in &seed.npc_sites {
        match npc_view(&deployer, &site.id).await? {
            Some(existing) => verify_npc(&existing, site)?,
            None => missing_sites.push(site),
        }
    }
    let plot_count: u16 = deployer.view(&contract_id, "plot_count").await?.json()?;
    let site_count: u8 = deployer
        .view(&contract_id, "npc_site_count")
        .await?
        .json()?;
    ensure!(
        usize::from(plot_count) + missing_plots.len() == seed.plots.len(),
        "unexpected on-chain plot records"
    );
    ensure!(
        usize::from(site_count) + missing_sites.len() == seed.npc_sites.len(),
        "unexpected on-chain NPC records"
    );
    println!(
        "Existing city: {plot_count} plots, {site_count} NPC sites; adding {} plots and {} sites",
        missing_plots.len(),
        missing_sites.len()
    );

    for plot in missing_plots {
        let outcome = deployer
            .call(&contract_id, "seed_plot")
            .args_json(json!({"seed": plot.contract_seed()}))
            .deposit(NearToken::from_near(1))
            .transact()
            .await?;
        ensure!(
            outcome.is_success(),
            "plot seed failed for {}: {outcome:?}",
            plot.id
        );
    }
    for site in missing_sites {
        let outcome = deployer
            .call(&contract_id, "seed_npc_site")
            .args_json(json!({"seed": site.contract_seed()}))
            .deposit(NearToken::from_near(1))
            .transact()
            .await?;
        ensure!(
            outcome.is_success(),
            "NPC seed failed for {}: {outcome:?}",
            site.id
        );
    }
    ensure!(
        deployer
            .view(&contract_id, "plot_count")
            .await?
            .json::<u16>()?
            == 80,
        "final plot count is not 80"
    );
    ensure!(
        deployer
            .view(&contract_id, "npc_site_count")
            .await?
            .json::<u8>()?
            == 7,
        "final NPC site count is not seven"
    );
    for plot in &seed.plots {
        let existing = plot_view(&deployer, &plot.id)
            .await?
            .context("seeded plot missing")?;
        verify_plot(&existing.plot, plot)?;
    }
    for site in &seed.npc_sites {
        let existing = npc_view(&deployer, &site.id)
            .await?
            .context("seeded NPC missing")?;
        verify_npc(&existing, site)?;
    }
    Ok(())
}

async fn apply(seed: &CitySeed, wasm: &[u8], local_hash: &str) -> Result<()> {
    let contract_id: AccountId = required_env("ESTATE_CONTRACT_ID")?.parse()?;
    let moderator_id: AccountId = required_env("ESTATE_MODERATOR_ID")?.parse()?;
    let inspector_id: AccountId = required_env("ESTATE_INSPECTOR_ID")?.parse()?;
    let key_file = PathBuf::from(required_env("ESTATE_DEPLOY_KEY_FILE")?);
    ensure!(
        contract_id.as_str().ends_with(".testnet"),
        "deployment account must be a .testnet account"
    );
    ensure!(
        contract_id != moderator_id && contract_id != inspector_id && moderator_id != inspector_id,
        "admin, moderator and inspector must be separate accounts"
    );

    let rpc_url = std::env::var("ESTATE_TESTNET_RPC_URL")
        .unwrap_or_else(|_| "https://test.rpc.fastnear.com".to_string());
    ensure!(
        rpc_url.starts_with("https://"),
        "testnet RPC must use HTTPS"
    );
    let worker = near_workspaces::testnet().rpc_addr(&rpc_url).await?;
    ensure!(
        worker.status().await?.chain_id == "testnet",
        "RPC is not testnet"
    );
    let deployer = Account::from_file(&key_file, &worker)?;
    ensure!(
        deployer.id() == &contract_id,
        "deployment key file belongs to a different account"
    );
    let account_details = deployer
        .view_account()
        .await
        .context("deployment account is unavailable")?;
    worker
        .view_account(&moderator_id)
        .await
        .context("moderator account is unavailable")?;
    worker
        .view_account(&inspector_id)
        .await
        .context("inspector account is unavailable")?;

    if account_details.contract_state == ContractState::None {
        let deployment = deployer.deploy(wasm).await?;
        ensure!(
            deployment.is_success(),
            "contract deployment failed: {:?}",
            deployment.details
        );
    } else {
        let current_code = worker.view_code(&contract_id).await?;
        ensure!(
            code_sha256(&current_code) == local_hash,
            "on-chain code differs from this build; refusing to overwrite it"
        );
    }

    let state = worker.view_state(&contract_id).prefix(b"STATE").await?;
    if !state.contains_key(&b"STATE".to_vec()) {
        let initialized = deployer
            .call(&contract_id, "new")
            .args_json(json!({
                "admin": contract_id,
                "moderator": moderator_id,
                "inspector": inspector_id
            }))
            .transact()
            .await?;
        ensure!(
            initialized.is_success(),
            "initialization failed: {initialized:?}"
        );
    }
    let roles: (AccountId, AccountId, AccountId) =
        deployer.view(&contract_id, "get_roles").await?.json()?;
    ensure!(
        roles
            == (
                contract_id.clone(),
                moderator_id.clone(),
                inspector_id.clone()
            ),
        "on-chain roles do not match deployment configuration"
    );
    let config: GameConfig = deployer.view(&contract_id, "get_config").await?.json()?;

    seed_city(&deployer, seed).await?;
    ensure!(
        code_sha256(&worker.view_code(&contract_id).await?) == local_hash,
        "deployed code hash changed"
    );
    let manifest = json!({
        "network": "testnet",
        "contractId": contract_id,
        "moderatorId": moderator_id,
        "inspectorId": inspector_id,
        "wasmSha256": local_hash,
        "configVersion": config.version,
        "citySeedVersion": seed.version,
        "plotCount": seed.plots.len(),
        "npcSiteCount": seed.npc_sites.len()
    });
    let path = estate_root().join("deployments/testnet.json");
    std::fs::create_dir_all(path.parent().context("deployment directory missing")?)?;
    std::fs::write(&path, near_sdk::serde_json::to_vec_pretty(&manifest)?)?;
    println!("Verified testnet deployment: {}", path.display());
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let mode = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "--plan".to_string());
    if mode != "--plan" && mode != "--apply" {
        bail!("usage: deploy_testnet [--plan|--apply]");
    }
    let seed_path = estate_root().join("contracts/estate/seed.json");
    let seed = load_seed(&seed_path)?;
    let path = wasm_path();
    let wasm = std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
    ensure!(
        wasm.starts_with(b"\0asm"),
        "contract file is not WebAssembly"
    );
    let hash = code_sha256(&wasm);
    println!("Contract build: {}", path.display());
    println!("SHA-256: {hash}");
    println!(
        "City seed v{}: {} plots, {} NPC sites",
        seed.version,
        seed.plots.len(),
        seed.npc_sites.len()
    );
    if mode == "--apply" {
        apply(&seed, &wasm, &hash).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn full_city_seed_retries_without_duplicate_records() -> Result<()> {
        let seed = load_seed(&estate_root().join("contracts/estate/seed.json"))?;
        let wasm = std::fs::read(wasm_path())?;
        let worker = near_workspaces::sandbox().await?;
        let account = worker.dev_create_account().await?;
        ensure!(
            account.view_account().await?.contract_state == ContractState::None,
            "new account has code"
        );
        let deployment = account.deploy(&wasm).await?;
        ensure!(deployment.is_success(), "sandbox deployment failed");
        let contract = deployment.result;
        ensure!(
            code_sha256(&worker.view_code(contract.id()).await?) == code_sha256(&wasm),
            "sandbox code hash mismatch"
        );
        ensure!(
            !worker
                .view_state(contract.id())
                .prefix(b"STATE")
                .await?
                .contains_key(&b"STATE".to_vec()),
            "new contract already has state"
        );
        let moderator = worker.dev_create_account().await?;
        let inspector = worker.dev_create_account().await?;
        let initialized = contract
            .call("new")
            .args_json(json!({
                "admin": contract.id(),
                "moderator": moderator.id(),
                "inspector": inspector.id()
            }))
            .transact()
            .await?;
        ensure!(initialized.is_success(), "sandbox initialization failed");
        ensure!(
            worker
                .view_state(contract.id())
                .prefix(b"STATE")
                .await?
                .contains_key(&b"STATE".to_vec()),
            "initialized contract has no state"
        );

        seed_city(contract.as_account(), &seed).await?;
        seed_city(contract.as_account(), &seed).await?;
        let plots: u16 = contract.view("plot_count").await?.json()?;
        let sites: u8 = contract.view("npc_site_count").await?.json()?;
        ensure!(
            plots == 80 && sites == 7,
            "seed retry changed city capacity"
        );
        Ok(())
    }
}
