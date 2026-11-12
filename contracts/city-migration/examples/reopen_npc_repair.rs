use anyhow::{ensure, Context, Result};
use near_estate_city_migration::CityRootV2;
use near_estate_contract::NPCSite;
use near_sdk::{
    borsh,
    serde_json::{json, Value},
};
use near_workspaces::{types::Gas, Account, AccountId};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::PathBuf, time::SystemTime};

const SITES: [(&str, u8); 7] = [
    ("npc-main-tower", 10),
    ("npc-market-tower", 10),
    ("npc-river-tower", 10),
    ("npc-central-garage", 10),
    ("npc-harbor-cinema", 10),
    ("npc-market-burgers", 11),
    ("npc-central-course", 11),
];

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn state_hash(state: &HashMap<Vec<u8>, Vec<u8>>) -> String {
    let mut entries: Vec<_> = state.iter().collect();
    entries.sort_by(|(left, _), (right, _)| left.cmp(right));
    let mut digest = Sha256::new();
    for (key, value) in entries {
        digest.update((key.len() as u64).to_le_bytes());
        digest.update(key);
        digest.update((value.len() as u64).to_le_bytes());
        digest.update(value);
    }
    format!("{:x}", digest.finalize())
}

fn write_record(path: &PathBuf, value: &Value) -> Result<()> {
    let temporary = path.with_extension("json.tmp");
    let mut bytes = Vec::new();
    let formatter = near_sdk::serde_json::ser::PrettyFormatter::with_indent(b"  ");
    value.serialize(&mut near_sdk::serde_json::Serializer::with_formatter(
        &mut bytes, formatter,
    ))?;
    bytes.push(b'\n');
    std::fs::write(&temporary, bytes)?;
    std::fs::rename(temporary, path)?;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "--plan".into());
    ensure!(
        mode == "--plan" || mode == "--apply" || mode == "--verify",
        "use --plan, --apply or --verify"
    );
    let manifest: Value =
        near_sdk::serde_json::from_slice(&std::fs::read(root().join("deployments/testnet.json"))?)?;
    ensure!(manifest["network"] == "testnet" && manifest["citySeedVersion"] == 2);
    let id: AccountId = manifest["contractId"]
        .as_str()
        .context("contract ID missing")?
        .parse()?;
    let code_hash = manifest["wasmSha256"]
        .as_str()
        .context("runtime hash missing")?;
    let record_path = root().join("deployments/testnet-v2-npc-frontage-repair-2026-11-12.json");
    let mut record: Value = near_sdk::serde_json::from_slice(&std::fs::read(&record_path)?)?;
    ensure!(record["contractId"] == id.as_str());
    ensure!(record["beforeCodeSha256"] == code_hash);
    ensure!(
        record["status"] == "verified_paused" || record["status"] == "active",
        "NPC repair is not verified"
    );
    let rpc_url = std::env::var("ESTATE_TESTNET_RPC_URL")
        .unwrap_or_else(|_| "https://test.rpc.fastnear.com".into());
    ensure!(rpc_url.starts_with("https://"));
    let worker = near_workspaces::testnet().rpc_addr(&rpc_url).await?;
    ensure!(worker.status().await?.chain_id == "testnet");
    ensure!(hash(&worker.view_code(&id).await?) == code_hash);
    let before = worker.view_state(&id).await?;
    let city: CityRootV2 = borsh::from_slice(
        before
            .get(b"STATE".as_slice())
            .context("city root missing")?,
    )?;
    ensure!(city.city_version == 2 && city.plot_count == 100);
    let sites: Vec<NPCSite> = worker
        .view(&id, "get_npc_sites")
        .args_json(json!({"from_index": 0, "limit": 7}))
        .await?
        .json()?;
    ensure!(sites.len() == 7);
    for (site, (id, new)) in sites.iter().zip(SITES) {
        ensure!(site.id == id && site.frontage_index == new);
    }
    if mode == "--plan" {
        ensure!(city.paused, "city is already active");
        ensure!(record["afterStateSha256"] == state_hash(&before));
        println!(
            "{}",
            json!({"readyToReopen": true, "sites": 7, "cityPaused": true})
        );
        return Ok(());
    }
    if mode == "--apply" {
        ensure!(city.paused, "city is already active; use --verify");
        ensure!(record["afterStateSha256"] == state_hash(&before));
        let key_file = PathBuf::from(
            std::env::var("ESTATE_DEPLOY_KEY_FILE")
                .context("ESTATE_DEPLOY_KEY_FILE is required")?,
        );
        let deployer = Account::from_file(&key_file, &worker)?;
        ensure!(
            deployer.id() == &id,
            "deployment key belongs to another account"
        );
        let result = deployer
            .call(&id, "set_paused")
            .args_json(json!({"paused": false}))
            .gas(Gas::from_tgas(20))
            .transact()
            .await?;
        ensure!(result.is_success(), "reopen transaction failed: {result:?}");
        record["resumeTransactionHash"] = json!(result.outcome().transaction_hash.to_string());
        write_record(&record_path, &record)?;
    }
    let after = worker.view_state(&id).await?;
    let mut resumed: CityRootV2 = borsh::from_slice(
        after
            .get(b"STATE".as_slice())
            .context("reopened root missing")?,
    )?;
    ensure!(!resumed.paused && resumed.city_version == 2 && resumed.plot_count == 100);
    resumed.paused = true;
    let mut normalized = after;
    normalized.insert(b"STATE".to_vec(), borsh::to_vec(&resumed)?);
    ensure!(record["afterStateSha256"] == state_hash(&normalized));
    record["status"] = json!("active");
    if record["reopenedAtMs"].is_null() {
        record["reopenedAtMs"] = json!(SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)?
            .as_millis() as u64);
    }
    write_record(&record_path, &record)?;
    println!(
        "Verified active city after NPC repair: {}",
        record_path.display()
    );
    Ok(())
}
