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
use std::{collections::HashMap, path::PathBuf, process::Command};

const SITES: [(&str, u8, u8); 7] = [
    ("npc-main-tower", 8, 10),
    ("npc-market-tower", 8, 10),
    ("npc-river-tower", 8, 10),
    ("npc-central-garage", 8, 10),
    ("npc-harbor-cinema", 8, 10),
    ("npc-market-burgers", 9, 11),
    ("npc-central-course", 9, 11),
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

fn expected_repair(before: &HashMap<Vec<u8>, Vec<u8>>) -> Result<HashMap<Vec<u8>, Vec<u8>>> {
    let mut expected = before.clone();
    let root: CityRootV2 = borsh::from_slice(
        before
            .get(b"STATE".as_slice())
            .context("version-2 root missing")?,
    )?;
    ensure!(root.paused && root.city_version == 2 && root.plot_count == 100);
    for (id, old, new) in SITES {
        let mut key = vec![b'n'];
        key.extend(borsh::to_vec(&id.to_string())?);
        let mut site: NPCSite = borsh::from_slice(before.get(&key).context("NPC site missing")?)?;
        ensure!(
            site.id == id && site.frontage_index == old,
            "NPC site moved"
        );
        site.frontage_index = new;
        expected.insert(key, borsh::to_vec(&site)?);
    }
    Ok(expected)
}

fn build_repair() -> Result<Vec<u8>> {
    let target = root().join("contracts/city-migration/target");
    let status = Command::new("cargo")
        .current_dir(root())
        .env("CARGO_TARGET_DIR", &target)
        .args([
            "build",
            "--manifest-path",
            "contracts/city-migration/Cargo.toml",
            "--release",
            "--target",
            "wasm32-unknown-unknown",
            "--features",
            "repair-npc",
        ])
        .status()?;
    ensure!(status.success(), "repair WASM build failed");
    let bytes = std::fs::read(
        target.join("wasm32-unknown-unknown/release/near_estate_city_migration.wasm"),
    )?;
    ensure!(bytes.starts_with(b"\0asm"), "repair WASM is invalid");
    Ok(bytes)
}

fn write_record(value: &Value) -> Result<PathBuf> {
    let path = root().join("deployments/testnet-v2-npc-frontage-repair-2026-11-12.json");
    let temporary = path.with_extension("json.tmp");
    let mut bytes = Vec::new();
    let formatter = near_sdk::serde_json::ser::PrettyFormatter::with_indent(b"  ");
    value.serialize(&mut near_sdk::serde_json::Serializer::with_formatter(
        &mut bytes, formatter,
    ))?;
    bytes.push(b'\n');
    std::fs::write(&temporary, bytes)?;
    std::fs::rename(temporary, &path)?;
    Ok(path)
}

#[tokio::main]
async fn main() -> Result<()> {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "--plan".into());
    ensure!(
        mode == "--plan" || mode == "--apply",
        "use --plan or --apply"
    );
    let manifest: Value =
        near_sdk::serde_json::from_slice(&std::fs::read(root().join("deployments/testnet.json"))?)?;
    ensure!(manifest["network"] == "testnet" && manifest["citySeedVersion"] == 2);
    let id: AccountId = manifest["contractId"]
        .as_str()
        .context("contract ID missing")?
        .parse()?;
    let old_hash = manifest["wasmSha256"]
        .as_str()
        .context("runtime hash missing")?;
    let rpc_url = std::env::var("ESTATE_TESTNET_RPC_URL")
        .unwrap_or_else(|_| "https://test.rpc.fastnear.com".into());
    ensure!(rpc_url.starts_with("https://"));
    let testnet = near_workspaces::testnet().rpc_addr(&rpc_url).await?;
    ensure!(testnet.status().await?.chain_id == "testnet");
    let old_wasm = testnet.view_code(&id).await?;
    ensure!(
        hash(&old_wasm) == old_hash,
        "runtime code differs from manifest"
    );
    let before = testnet.view_state(&id).await?;
    let expected = expected_repair(&before)?;
    let repair_wasm = build_repair()?;
    let repair_hash = hash(&repair_wasm);
    let sandbox = near_workspaces::sandbox().await?;
    let imported = sandbox
        .import_contract(&id, &testnet)
        .with_data()
        .transact()
        .await?;
    ensure!(
        sandbox.view_state(&id).await? == before,
        "sandbox import differs"
    );
    let deployed = imported.as_account().deploy(&repair_wasm).await?;
    ensure!(
        deployed.is_success(),
        "sandbox repair code deployment failed"
    );
    let repaired = imported
        .as_account()
        .call(&id, "repair_npc_frontages")
        .gas(Gas::from_tgas(80))
        .transact()
        .await?;
    ensure!(
        repaired.is_success(),
        "sandbox NPC repair failed: {repaired:?}"
    );
    ensure!(
        sandbox.view_state(&id).await? == expected,
        "repair changed other storage"
    );
    let restored = imported.as_account().deploy(&old_wasm).await?;
    ensure!(restored.is_success(), "sandbox runtime restore failed");
    ensure!(
        sandbox.view_state(&id).await? == expected,
        "runtime restore changed storage"
    );
    let sites: Vec<NPCSite> = sandbox
        .view(&id, "get_npc_sites")
        .args_json(json!({"from_index": 0, "limit": 7}))
        .await?
        .json()?;
    ensure!(sites.len() == 7);
    for (site, (id, _, new)) in sites.iter().zip(SITES) {
        ensure!(site.id == id && site.frontage_index == new);
    }
    let base = json!({
        "contractId": id,
        "beforeCodeSha256": old_hash,
        "repairWasmSha256": repair_hash,
        "beforeStateSha256": state_hash(&before),
        "afterStateSha256": state_hash(&expected),
        "sitesMoved": 7,
        "sandboxExactStorageVerified": true,
        "sandboxRuntimeRestored": true,
    });
    if mode == "--plan" {
        println!("{}", near_sdk::serde_json::to_string_pretty(&base)?);
        return Ok(());
    }
    let key_file = PathBuf::from(
        std::env::var("ESTATE_DEPLOY_KEY_FILE").context("ESTATE_DEPLOY_KEY_FILE is required")?,
    );
    let deployer = Account::from_file(&key_file, &testnet)?;
    ensure!(
        deployer.id() == &id,
        "deployment key belongs to another account"
    );
    ensure!(
        testnet.view_state(&id).await? == before,
        "live state changed after rehearsal"
    );
    let mut record = base;
    record["status"] = json!("prepared");
    let record_path = write_record(&record)?;
    let deployed = deployer.deploy(&repair_wasm).await?;
    ensure!(deployed.is_success(), "repair code deployment failed");
    record["repairDeployTransactionHash"] =
        json!(deployed.details.outcome().transaction_hash.to_string());
    record["status"] = json!("repair_code_deployed");
    write_record(&record)?;
    ensure!(hash(&testnet.view_code(&id).await?) == repair_hash);
    let repaired = deployer
        .call(&id, "repair_npc_frontages")
        .gas(Gas::from_tgas(80))
        .transact()
        .await?;
    ensure!(
        repaired.is_success(),
        "live NPC repair failed: {repaired:?}"
    );
    record["repairTransactionHash"] = json!(repaired.outcome().transaction_hash.to_string());
    record["status"] = json!("sites_repaired");
    write_record(&record)?;
    ensure!(
        testnet.view_state(&id).await? == expected,
        "live repair changed other storage"
    );
    let restored = deployer.deploy(&old_wasm).await?;
    ensure!(restored.is_success(), "runtime code restoration failed");
    record["runtimeRestoreTransactionHash"] =
        json!(restored.details.outcome().transaction_hash.to_string());
    record["status"] = json!("runtime_restored");
    write_record(&record)?;
    ensure!(hash(&testnet.view_code(&id).await?) == old_hash);
    ensure!(testnet.view_state(&id).await? == expected);
    record["status"] = json!("verified_paused");
    write_record(&record)?;
    println!("Verified paused city NPC repair: {}", record_path.display());
    Ok(())
}
