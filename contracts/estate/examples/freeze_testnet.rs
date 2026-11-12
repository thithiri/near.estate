use anyhow::{ensure, Context, Result};
use near_sdk::serde_json::{json, Value};
use near_workspaces::{types::Gas, Account, AccountId};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{os::unix::fs::PermissionsExt, path::PathBuf, time::Duration};

const PAUSE_CODE_SHA256: &str = "8132e2ab092bdfa0ddb368f894edb5782b95a049cad094d4b2410d007b4fab0c";

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn write_json(path: &PathBuf, value: &Value) -> Result<()> {
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
        mode == "--plan" || mode == "--apply",
        "use --plan or --apply"
    );
    let deployment: Value =
        near_sdk::serde_json::from_slice(&std::fs::read(root().join("deployments/testnet.json"))?)?;
    ensure!(
        deployment["network"] == "testnet",
        "deployment is not testnet"
    );
    let city_version = deployment["citySeedVersion"]
        .as_u64()
        .context("deployment has no city version")?;
    ensure!(
        city_version == 1 || city_version == 2,
        "unknown city version"
    );
    let expected_code = deployment["wasmSha256"]
        .as_str()
        .context("deployment has no code hash")?;
    if city_version == 1 {
        ensure!(
            expected_code == PAUSE_CODE_SHA256,
            "version-1 deployment is not the tested pause guard"
        );
    }
    let id: AccountId = deployment["contractId"]
        .as_str()
        .context("deployment has no contract ID")?
        .parse()?;
    let rpc_url = std::env::var("ESTATE_TESTNET_RPC_URL")
        .unwrap_or_else(|_| "https://test.rpc.fastnear.com".into());
    ensure!(rpc_url.starts_with("https://"), "RPC must use HTTPS");
    let worker = near_workspaces::testnet().rpc_addr(&rpc_url).await?;
    ensure!(
        worker.status().await?.chain_id == "testnet",
        "RPC is not testnet"
    );
    ensure!(
        hash(&worker.view_code(&id).await?) == expected_code,
        "live code differs from the deployment manifest"
    );
    let plots: u16 = worker.view(&id, "plot_count").await?.json()?;
    let sites: u8 = worker.view(&id, "npc_site_count").await?.json()?;
    let roles: (AccountId, AccountId, AccountId) = worker.view(&id, "get_roles").await?.json()?;
    ensure!(
        u64::from(plots) == deployment["plotCount"].as_u64().unwrap_or(0) && sites == 7,
        "city counts differ from the deployment manifest"
    );
    ensure!(roles.0 == id, "contract account is not the admin");
    let already_paused: bool = worker.view(&id, "is_paused").await?.json()?;
    if mode == "--plan" {
        println!(
            "{}",
            json!({
                "contractId": id,
                "codeSha256": expected_code,
                "plotCount": plots,
                "npcSiteCount": sites,
                "paused": already_paused,
                "action": if already_paused { "already frozen" } else { "set_paused(true)" },
            })
        );
        return Ok(());
    }
    if already_paused {
        println!("City is already paused; repeat the pinned inventory.");
        return Ok(());
    }
    let key_file = PathBuf::from(
        std::env::var("ESTATE_DEPLOY_KEY_FILE").context("ESTATE_DEPLOY_KEY_FILE is required")?,
    );
    ensure!(
        key_file.is_absolute(),
        "deployment key path must be absolute"
    );
    let key_file = key_file.canonicalize()?;
    ensure!(
        !key_file.starts_with(root().canonicalize()?),
        "deployment key must stay outside the repository"
    );
    ensure!(
        std::fs::metadata(&key_file)?.permissions().mode() & 0o077 == 0,
        "deployment key must have private permissions"
    );
    let deployer = Account::from_file(&key_file, &worker)?;
    ensure!(
        deployer.id() == &id,
        "deployment key belongs to another account"
    );
    let result = deployer
        .call(&id, "set_paused")
        .args_json(json!({"paused": true}))
        .gas(Gas::from_tgas(20))
        .transact()
        .await?;
    ensure!(
        result.is_success(),
        "pause transaction failed: {:?}",
        result
    );
    for attempt in 0..15 {
        let paused: bool = worker.view(&id, "is_paused").await?.json()?;
        if paused {
            let record = json!({
                "network": "testnet",
                "contractId": id,
                "codeSha256": expected_code,
                "transactionHash": result.outcome().transaction_hash.to_string(),
                "blockHash": result.outcome().block_hash.to_string(),
                "pausedAtFinality": true,
                "plotCount": plots,
                "npcSiteCount": sites,
            });
            let path = if city_version == 1 {
                root().join("deployments/variable-city-freeze-2026-11-12.json")
            } else {
                root().join("deployments/variable-city-freeze-v2-repair-2026-11-12.json")
            };
            write_json(&path, &record)?;
            println!("Verified paused city; public record: {}", path.display());
            return Ok(());
        }
        if attempt < 14 {
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }
    anyhow::bail!("pause transaction succeeded but final view is not paused yet")
}
