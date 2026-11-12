use anyhow::{ensure, Context, Result};
use near_estate_city_migration::CityRootV2;
use near_sdk::{
    borsh::BorshDeserialize,
    serde_json::{json, Value},
};
use near_workspaces::AccountId;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::PathBuf};

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

async fn views(
    worker: &near_workspaces::Worker<impl near_workspaces::Network + 'static>,
    id: &AccountId,
) -> Result<Vec<Value>> {
    let plot = worker
        .view(id, "get_plot")
        .args_json(json!({"plot_id": "plot-main-n-3"}))
        .await?
        .json()?;
    let config = worker.view(id, "get_config").await?.json()?;
    let roles = worker.view(id, "get_roles").await?.json()?;
    let mut result = vec![plot, config, roles];
    for road_id in ["main", "market", "river", "central", "harbor"] {
        for side in ["North", "South"] {
            let street: Value = worker
                .view(id, "get_street_side")
                .args_json(json!({"road_id": road_id, "side": side}))
                .await?
                .json()?;
            let plots = street["plots"].as_array().context("street plots missing")?;
            ensure!(plots.len() == 10, "street side has fewer than ten plots");
            for entry in plots {
                let units = entry["plot"]["plot"]["frontage_units"]
                    .as_u64()
                    .context("plot width missing")?;
                ensure!(
                    entry["slots"]
                        .as_array()
                        .is_some_and(|slots| slots.len() == units as usize),
                    "street curb slots do not match plot width"
                );
            }
            result.push(street);
        }
    }
    Ok(result)
}

#[tokio::main]
async fn main() -> Result<()> {
    ensure!(
        std::env::args().nth(1).as_deref() == Some("--read-only-live-import"),
        "use --read-only-live-import; this command never signs a testnet transaction"
    );
    let manifest: Value =
        near_sdk::serde_json::from_slice(&std::fs::read(root().join("deployments/testnet.json"))?)?;
    ensure!(
        manifest["network"] == "testnet",
        "deployment is not testnet"
    );
    let id: AccountId = manifest["contractId"]
        .as_str()
        .context("contract ID missing")?
        .parse()?;
    let expected_live_code = manifest["wasmSha256"]
        .as_str()
        .context("live code hash missing")?;
    let wasm_path = std::env::var_os("ESTATE_V2_WASM")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            root().join(
                "contracts/city-migration/target/wasm32-unknown-unknown/release/near_estate_city_migration.wasm",
            )
        });
    let candidate = std::fs::read(&wasm_path).context("build candidate runtime WASM first")?;
    ensure!(candidate.starts_with(b"\0asm"), "candidate WASM is invalid");
    let candidate_hash = hash(&candidate);
    ensure!(
        candidate_hash != expected_live_code,
        "candidate is already live"
    );
    let rpc_url = std::env::var("ESTATE_TESTNET_RPC_URL")
        .unwrap_or_else(|_| "https://test.rpc.fastnear.com".to_string());
    ensure!(
        rpc_url.starts_with("https://"),
        "testnet RPC must use HTTPS"
    );
    let testnet = near_workspaces::testnet().rpc_addr(&rpc_url).await?;
    ensure!(
        testnet.status().await?.chain_id == "testnet",
        "RPC is not testnet"
    );

    let sandbox = near_workspaces::sandbox().await?;
    let imported = sandbox
        .import_contract(&id, &testnet)
        .with_data()
        .transact()
        .await
        .context("import current testnet contract into local sandbox")?;
    let imported_code = sandbox.view_code(&id).await?;
    ensure!(
        hash(&imported_code) == expected_live_code,
        "imported contract code differs from deployment manifest"
    );
    let before = sandbox.view_state(&id).await?;
    let before_hash = state_hash(&before);
    let before_root: CityRootV2 = BorshDeserialize::try_from_slice(
        before
            .get(b"STATE".as_slice())
            .context("city root missing")?,
    )?;
    ensure!(
        before_root.city_version == 2 && before_root.plot_count == 100,
        "imported state is not the expected version-2 city"
    );
    let before_views = views(&sandbox, &id).await?;
    ensure!(
        !before_views[0].is_null(),
        "review plot missing before upgrade"
    );
    let deployed = imported.as_account().deploy(&candidate).await?;
    ensure!(deployed.is_success(), "candidate sandbox deployment failed");
    let after = sandbox.view_state(&id).await?;
    ensure!(
        after == before,
        "candidate upgrade changed stored city state"
    );
    ensure!(
        hash(&sandbox.view_code(&id).await?) == candidate_hash,
        "candidate code hash differs after sandbox deployment"
    );
    ensure!(
        views(&sandbox, &id).await? == before_views,
        "candidate upgrade changed public city views"
    );
    let restored = imported.as_account().deploy(&imported_code).await?;
    ensure!(restored.is_success(), "old WASM rollback failed in sandbox");
    let rollback_state = sandbox.view_state(&id).await?;
    ensure!(
        rollback_state == before,
        "old WASM rollback changed stored city state"
    );
    ensure!(
        hash(&sandbox.view_code(&id).await?) == expected_live_code,
        "old WASM code hash differs after rollback"
    );
    ensure!(
        views(&sandbox, &id).await? == before_views,
        "old WASM rollback changed public city views"
    );
    let evidence = json!({
        "scope": "read-only testnet import; candidate deployed only to local sandbox",
        "contractId": id,
        "liveCodeSha256": expected_live_code,
        "candidateCodeSha256": candidate_hash,
        "cityVersion": before_root.city_version,
        "plotCount": before_root.plot_count,
        "npcSiteCount": before_root.npc_site_count,
        "stateEntries": before.len(),
        "stateSha256Before": before_hash,
        "stateSha256After": state_hash(&after),
        "stateSha256AfterRollback": state_hash(&rollback_state),
        "streetSideViewsChecked": 10,
        "plotsCoveredByViews": 100,
        "publicViewsUnchanged": true,
        "rollbackCodeSha256": expected_live_code,
        "rollbackPublicViewsUnchanged": true,
    });
    let path = root().join(format!(
        "deployments/runtime-upgrade-sandbox-{}.json",
        &candidate_hash[..16]
    ));
    std::fs::write(
        &path,
        format!("{}\n", near_sdk::serde_json::to_string_pretty(&evidence)?),
    )?;
    println!("{}", near_sdk::serde_json::to_string_pretty(&evidence)?);
    Ok(())
}
