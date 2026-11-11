use anyhow::{ensure, Context, Result};
use near_estate_migration_probe::{RootV1, RootV2};
use near_sdk::{
    borsh,
    serde_json::{json, Value},
};
use near_workspaces::{
    network::{NetworkClient, NetworkInfo},
    AccountId, Worker,
};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::PathBuf, process::Command};

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

fn build_probe(reverse: bool) -> Result<Vec<u8>> {
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let mut command = Command::new(cargo);
    command
        .args([
            "build",
            "--release",
            "--target",
            "wasm32-unknown-unknown",
            "-p",
            "near-estate-migration-probe",
        ])
        .current_dir(root());
    if reverse {
        command.args(["--features", "reverse"]);
    }
    let status = command
        .status()
        .context("could not build migration probe")?;
    ensure!(status.success(), "migration probe WASM build failed");
    let wasm = std::fs::read(
        root().join("target/wasm32-unknown-unknown/release/near_estate_migration_probe.wasm"),
    )?;
    ensure!(
        wasm.starts_with(b"\0asm"),
        "migration probe WASM is invalid"
    );
    Ok(wasm)
}

async fn old_views<N: NetworkClient + NetworkInfo + Send + Sync + 'static>(
    worker: &Worker<N>,
    id: &AccountId,
    owner: &AccountId,
) -> Result<Value> {
    let roles: Value = worker.view(id, "get_roles").await?.json()?;
    let config: Value = worker.view(id, "get_config").await?.json()?;
    let plot_count: u16 = worker.view(id, "plot_count").await?.json()?;
    let site_count: u8 = worker.view(id, "npc_site_count").await?.json()?;
    let tower: u8 = worker
        .view(id, "get_tower_availability")
        .args_json(json!({"site_id": "npc-main-tower"}))
        .await?
        .json()?;
    let street: Value = worker
        .view(id, "get_street_side")
        .args_json(json!({"road_id": "main", "side": "North"}))
        .await?
        .json()?;
    let account: Value = worker
        .view(id, "get_account")
        .args_json(json!({"account_id": owner}))
        .await?
        .json()?;
    let cars: Value = worker
        .view(id, "get_cars")
        .args_json(json!({"account_id": owner}))
        .await?
        .json()?;
    Ok(json!({
        "roles": roles,
        "config": config,
        "plotCount": plot_count,
        "siteCount": site_count,
        "towerAvailable": tower,
        "street": street,
        "account": account,
        "cars": cars,
    }))
}

#[tokio::main]
async fn main() -> Result<()> {
    ensure!(
        std::env::args().nth(1).as_deref() == Some("--live-import"),
        "use --live-import; this command only writes to a local sandbox"
    );
    let manifest: Value =
        near_sdk::serde_json::from_slice(&std::fs::read(root().join("deployments/testnet.json"))?)?;
    ensure!(manifest["network"] == "testnet", "manifest is not testnet");
    let id: AccountId = manifest["contractId"]
        .as_str()
        .context("contract ID missing")?
        .parse()?;
    let expected_old_hash = manifest["wasmSha256"]
        .as_str()
        .context("contract code hash missing")?;
    let owner_record: Value = near_sdk::serde_json::from_slice(&std::fs::read(
        root().join("deployments/testnet-shared-owner-journey.json"),
    )?)?;
    ensure!(
        owner_record["contractId"] == id.as_str(),
        "owner record belongs to another city"
    );
    let owner: AccountId = owner_record["ownerId"]
        .as_str()
        .context("owner ID missing")?
        .parse()?;
    let forward_wasm = build_probe(false)?;
    let reverse_wasm = build_probe(true)?;
    let rpc_url = std::env::var("ESTATE_TESTNET_RPC_URL")
        .unwrap_or_else(|_| "https://test.rpc.fastnear.com".to_string());
    ensure!(rpc_url.starts_with("https://"), "RPC must use HTTPS");
    let testnet = near_workspaces::testnet().rpc_addr(&rpc_url).await?;
    ensure!(
        testnet.status().await?.chain_id == "testnet",
        "RPC is not testnet"
    );
    let old_wasm = testnet.view_code(&id).await?;
    ensure!(
        hash(&old_wasm) == expected_old_hash,
        "live code differs from manifest"
    );
    let live_state = testnet.view_state(&id).await?;
    let before_hash = state_hash(&live_state);
    let root_bytes = live_state
        .get(b"STATE".as_slice())
        .context("live root state missing")?;
    let old_root: RootV1 =
        borsh::from_slice(root_bytes).context("live V1 root cannot be decoded")?;
    ensure!(
        old_root.admin == id && old_root.plot_count == 80 && old_root.npc_site_count == 7,
        "unexpected live root"
    );
    ensure!(
        borsh::to_vec(&old_root)? == *root_bytes,
        "V1 root did not round trip exactly"
    );
    let expected_views = old_views(&testnet, &id, &owner).await?;
    println!("Importing the exact live city into a local sandbox...");
    let sandbox = near_workspaces::sandbox().await?;
    let copy = sandbox
        .import_contract(&id, &testnet)
        .with_data()
        .transact()
        .await?;
    ensure!(
        hash(&sandbox.view_code(&id).await?) == expected_old_hash,
        "sandbox code differs"
    );
    ensure!(
        state_hash(&sandbox.view_state(&id).await?) == before_hash,
        "sandbox state differs"
    );
    ensure!(
        old_views(&sandbox, &id, &owner).await? == expected_views,
        "sandbox views differ"
    );
    let deploy_forward = copy.as_account().deploy(&forward_wasm).await?;
    ensure!(deploy_forward.is_success(), "forward probe deploy failed");
    let outsider = sandbox.dev_create_account().await?;
    let unauthorized = outsider.call(&id, "migrate").transact().await?;
    ensure!(
        !unauthorized.is_success(),
        "outsider migrated contract state"
    );
    ensure!(
        state_hash(&sandbox.view_state(&id).await?) == before_hash,
        "failed migration changed state"
    );
    let migrated = copy.as_account().call(&id, "migrate").transact().await?;
    ensure!(migrated.is_success(), "migration failed: {migrated:?}");
    let migrated_state = sandbox.view_state(&id).await?;
    let new_root_bytes = migrated_state
        .get(b"STATE".as_slice())
        .context("V2 root missing")?;
    let new_root: RootV2 =
        borsh::from_slice(new_root_bytes).context("V2 root cannot be decoded")?;
    ensure!(new_root.schema_version == 2, "V2 marker differs");
    let mut expected_root = root_bytes.clone();
    expected_root.extend_from_slice(&2u32.to_le_bytes());
    ensure!(
        *new_root_bytes == expected_root,
        "migration changed V1 root fields"
    );
    ensure!(
        migrated_state.len() == live_state.len()
            && live_state
                .iter()
                .all(|(key, value)| key.as_slice() == b"STATE"
                    || migrated_state.get(key) == Some(value)),
        "migration changed a non-root storage key"
    );
    let version: u32 = sandbox.view(&id, "get_schema_version").await?.json()?;
    ensure!(version == 2, "V2 view differs");
    let snapshot: Value = sandbox.view(&id, "get_root_snapshot").await?.json()?;
    ensure!(
        snapshot[0] == id.as_str() && snapshot[4] == 80 && snapshot[5] == 7,
        "V2 root view differs"
    );
    let second = copy.as_account().call(&id, "migrate").transact().await?;
    ensure!(!second.is_success(), "second migration succeeded");
    ensure!(
        sandbox.view_state(&id).await? == migrated_state,
        "second migration changed state"
    );
    let deploy_reverse = copy.as_account().deploy(&reverse_wasm).await?;
    ensure!(deploy_reverse.is_success(), "reverse probe deploy failed");
    let reversed = copy.as_account().call(&id, "reverse").transact().await?;
    ensure!(
        reversed.is_success(),
        "reverse migration failed: {reversed:?}"
    );
    ensure!(
        sandbox.view_state(&id).await? == live_state,
        "reverse migration did not restore exact state"
    );
    let restore_code = copy.as_account().deploy(&old_wasm).await?;
    ensure!(restore_code.is_success(), "old code restore failed");
    ensure!(
        hash(&sandbox.view_code(&id).await?) == expected_old_hash,
        "old code hash not restored"
    );
    ensure!(
        old_views(&sandbox, &id, &owner).await? == expected_views,
        "restored game views differ"
    );
    let record = json!({
        "result": "passed",
        "network": "testnet",
        "scope": "sandbox import only; no live testnet state changed",
        "contractId": id,
        "liveCodeSha256": expected_old_hash,
        "forwardProbeSha256": hash(&forward_wasm),
        "reverseProbeSha256": hash(&reverse_wasm),
        "beforeAndRestoredStateSha256": before_hash,
        "migratedStateSha256": state_hash(&migrated_state),
        "storageKeys": live_state.len(),
        "schemaVersion": version,
        "unauthorizedRejected": true,
        "secondMigrationRejected": true,
        "nonRootStorageUnchanged": true,
        "oldViewsRestored": true,
    });
    let path = root().join("deployments/testnet-root-migration-rehearsal.json");
    let mut output = near_sdk::serde_json::to_vec_pretty(&record)?;
    output.push(b'\n');
    std::fs::write(&path, output)?;
    println!("Migration and exact reverse passed: {}", path.display());
    Ok(())
}
