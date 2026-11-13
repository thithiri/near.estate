use anyhow::{ensure, Context, Result};
use near_estate_city_migration::CityRootV2;
use near_estate_contract::{NPCSite, RoadId, ServiceRole, Side};
use near_sdk::{
    borsh,
    serde_json::{json, Value},
};
use near_workspaces::{types::Gas, Account, AccountId};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs, path::PathBuf};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn expected_site() -> NPCSite {
    NPCSite {
        id: "npc-harbor-horse-course".into(),
        road_id: RoadId::Harbor,
        side: Side::South,
        frontage_index: 10,
        role: ServiceRole::HorseCourse,
        name: "Harbor Horse Course".into(),
        capacity: 0,
    }
}

fn expected_state(before: &HashMap<Vec<u8>, Vec<u8>>) -> Result<HashMap<Vec<u8>, Vec<u8>>> {
    let mut expected = before.clone();
    let mut city: CityRootV2 = borsh::from_slice(
        before
            .get(b"STATE".as_slice())
            .context("city root missing")?,
    )?;
    ensure!(
        city.city_version == 2
            && city.plot_count == 100
            && city.npc_site_count == 7
            && !city.paused,
        "unexpected city state"
    );
    city.npc_site_count = 8;
    expected.insert(b"STATE".to_vec(), borsh::to_vec(&city)?);
    let site = expected_site();
    let mut site_key = vec![b'n'];
    site_key.extend(borsh::to_vec(&site.id)?);
    ensure!(
        !expected.contains_key(&site_key),
        "horse site already stored"
    );
    expected.insert(site_key, borsh::to_vec(&site)?);
    let mut id_key = vec![b'j'];
    id_key.extend(borsh::to_vec(&7_u8)?);
    ensure!(
        !expected.contains_key(&id_key),
        "eighth NPC index already stored"
    );
    expected.insert(id_key, borsh::to_vec(&site.id)?);
    Ok(expected)
}

#[tokio::main]
async fn main() -> Result<()> {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "--plan".into());
    ensure!(
        mode == "--plan" || mode == "--apply",
        "use --plan or --apply"
    );
    let manifest_path = root().join("deployments/testnet.json");
    let mut manifest: Value = near_sdk::serde_json::from_slice(&fs::read(&manifest_path)?)?;
    ensure!(
        manifest["network"] == "testnet" && manifest["citySeedVersion"] == 2,
        "wrong network or city"
    );
    let id: AccountId = manifest["contractId"]
        .as_str()
        .context("contract ID missing")?
        .parse()?;
    let rpc_url = std::env::var("ESTATE_TESTNET_RPC_URL")
        .unwrap_or_else(|_| "https://test.rpc.fastnear.com".into());
    ensure!(
        rpc_url.starts_with("https://"),
        "testnet RPC must use HTTPS"
    );
    let testnet = near_workspaces::testnet().rpc_addr(&rpc_url).await?;
    ensure!(testnet.status().await?.chain_id == "testnet", "wrong chain");
    let live_code = testnet.view_code(&id).await?;
    ensure!(
        hash(&live_code)
            == manifest["wasmSha256"]
                .as_str()
                .context("manifest code hash missing")?,
        "live code differs from manifest"
    );
    let candidate = fs::read(root().join("contracts/city-migration/target/wasm32-unknown-unknown/release/near_estate_city_migration.wasm"))?;
    ensure!(candidate.starts_with(b"\0asm"), "candidate WASM is invalid");
    let candidate_hash = hash(&candidate);
    let before = testnet.view_state(&id).await?;
    let root_before: CityRootV2 = borsh::from_slice(
        before
            .get(b"STATE".as_slice())
            .context("city root missing")?,
    )?;
    if root_before.npc_site_count == 8 {
        let site: NPCSite = testnet
            .view(&id, "get_npc_site")
            .args_json(json!({"site_id": expected_site().id}))
            .await?
            .json()?;
        ensure!(
            site == expected_site(),
            "eighth site differs from Harbor course"
        );
        ensure!(
            manifest["npcSiteCount"] == 8,
            "live site exists but deployment manifest needs recovery"
        );
        println!("Harbor Horse Course is already live");
        return Ok(());
    }
    let expected = expected_state(&before)?;
    let sandbox = near_workspaces::sandbox().await?;
    let imported = sandbox
        .import_contract(&id, &testnet)
        .with_data()
        .transact()
        .await?;
    ensure!(
        sandbox.view_state(&id).await? == before,
        "sandbox import changed state"
    );
    if hash(&live_code) != candidate_hash {
        let deployed = imported.as_account().deploy(&candidate).await?;
        ensure!(deployed.is_success(), "candidate sandbox deployment failed");
        ensure!(
            sandbox.view_state(&id).await? == before,
            "candidate deployment changed state"
        );
    }
    let seeded = imported
        .as_account()
        .call(&id, "add_horse_course_site")
        .gas(Gas::from_tgas(80))
        .transact()
        .await?;
    ensure!(
        seeded.is_success(),
        "sandbox course seed failed: {seeded:?}"
    );
    ensure!(
        sandbox.view_state(&id).await? == expected,
        "sandbox seed changed unexpected storage"
    );
    let site: NPCSite = sandbox
        .view(&id, "get_npc_site")
        .args_json(json!({"site_id": expected_site().id}))
        .await?
        .json()?;
    ensure!(site == expected_site(), "sandbox site differs");
    let summary = json!({"contractId":id,"candidateCodeSha256":candidate_hash,"beforeSiteCount":7,"afterSiteCount":8,"sandboxExactStorageVerified":true,"site":site});
    if mode == "--plan" {
        println!("{}", near_sdk::serde_json::to_string_pretty(&summary)?);
        return Ok(());
    }
    ensure!(
        hash(&live_code) == candidate_hash,
        "deploy candidate runtime before seeding course"
    );
    let key_file = PathBuf::from(
        std::env::var("ESTATE_DEPLOY_KEY_FILE").context("ESTATE_DEPLOY_KEY_FILE required")?,
    );
    let signer = Account::from_file(&key_file, &testnet)?;
    ensure!(
        signer.id() == &id,
        "deployment key belongs to another account"
    );
    ensure!(
        testnet.view_state(&id).await? == before,
        "live state changed after rehearsal"
    );
    let result = signer
        .call(&id, "add_horse_course_site")
        .gas(Gas::from_tgas(80))
        .transact()
        .await?;
    ensure!(result.is_success(), "live course seed failed: {result:?}");
    ensure!(
        testnet.view_state(&id).await? == expected,
        "live seed changed unexpected storage"
    );
    let mut record = summary;
    record["status"] = json!("verified");
    record["transactionHash"] = json!(result.outcome().transaction_hash.to_string());
    fs::write(
        root().join("deployments/testnet-horse-course-site.json"),
        format!("{}\n", near_sdk::serde_json::to_string_pretty(&record)?),
    )?;
    manifest["npcSiteCount"] = json!(8);
    fs::write(
        &manifest_path,
        format!("{}\n", near_sdk::serde_json::to_string_pretty(&manifest)?),
    )?;
    println!("{}", near_sdk::serde_json::to_string_pretty(&record)?);
    Ok(())
}
