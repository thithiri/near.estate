use anyhow::{ensure, Context, Result};
use near_estate_contract::{
    BuildingType, CarBody, CarColor, MediaDecisionStatus, MediaIdentity, MediaKind, MediaProposal,
    PlotSeed, PlotView, RoadId, Side,
};
use near_sdk::{
    json_types::U128,
    serde_json::{json, Value},
};
use near_workspaces::{
    types::{AccessKey, AccessKeyPermission, KeyType, NearToken, SecretKey},
    Account,
};
use std::path::PathBuf;

const PLOT_ID: &str = "plot-main-n-0";
const ALLOWANCE_YOCTO: u128 = 500_000_000_000_000_000_000_000;
const INSPECTOR_ALLOWANCE_YOCTO: u128 = 250_000_000_000_000_000_000_000;
const METHODS: [&str; 6] = [
    "approve_appearance",
    "reject_appearance",
    "revoke_appearance",
    "approve_media",
    "reject_media",
    "revoke_media",
];

fn wasm_path() -> PathBuf {
    std::env::var_os("ESTATE_WASM")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../target/wasm32-unknown-unknown/release/near_estate_contract.wasm")
        })
}

#[tokio::test]
async fn restricted_moderator_and_inspector_keys_rotate_on_sandbox() -> Result<()> {
    let wasm = std::fs::read(wasm_path())?;
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm).await?;
    let moderator = worker.dev_create_account().await?;
    let inspector = worker.dev_create_account().await?;
    let owner = worker.dev_create_account().await?;
    let driver = worker.dev_create_account().await?;

    let init = contract
        .call("new")
        .args_json(json!({
            "admin": contract.id(), "moderator": moderator.id(), "inspector": inspector.id()
        }))
        .transact()
        .await?;
    ensure!(
        init.is_success(),
        "contract initialization failed: {init:?}"
    );
    let seed = contract
        .call("seed_plot")
        .args_json(json!({"seed": PlotSeed {
            road_id: RoadId::Main,
            side: Side::North,
            index: 0,
            building_type: BuildingType::Retail,
            variant: 1,
        }}))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?;
    ensure!(seed.is_success(), "plot seed failed: {seed:?}");
    let registration_quote: U128 = contract.view("registration_quote").await?.json()?;
    let registration = owner
        .call(contract.id(), "register_player")
        .args_json(json!({"body": CarBody::Hatchback, "color": CarColor::Red}))
        .deposit(NearToken::from_yoctonear(registration_quote.0))
        .transact()
        .await?;
    ensure!(
        registration.is_success(),
        "registration failed: {registration:?}"
    );
    let driver_registration = driver
        .call(contract.id(), "register_player")
        .args_json(json!({"body": CarBody::Hatchback, "color": CarColor::Blue}))
        .deposit(NearToken::from_yoctonear(registration_quote.0))
        .transact()
        .await?;
    ensure!(
        driver_registration.is_success(),
        "driver registration failed: {driver_registration:?}"
    );
    let starter_car: Value = driver_registration.json()?;
    let car_id = starter_car["id"]
        .as_u64()
        .context("starter car ID is missing")?;
    let purchase_quote: U128 = contract
        .view("plot_purchase_quote")
        .args_json(json!({"plot_id": PLOT_ID}))
        .await?
        .json()?;
    let purchase = owner
        .call(contract.id(), "buy_plot")
        .args_json(json!({"plot_id": PLOT_ID}))
        .deposit(NearToken::from_yoctonear(purchase_quote.0))
        .transact()
        .await?;
    ensure!(purchase.is_success(), "plot purchase failed: {purchase:?}");
    let before: PlotView = contract
        .view("get_plot")
        .args_json(json!({"plot_id": PLOT_ID}))
        .await?
        .json()?;
    let content = MediaIdentity {
        asset_hash: "a".repeat(64),
        link: Some("https://example.com/brand".to_string()),
    };
    let proposed = owner
        .call(contract.id(), "propose_media")
        .args_json(json!({
            "plot_id": PLOT_ID,
            "kind": MediaKind::Logo,
            "expected_media_revision": before.plot.logo.revision,
            "expected_layout_revision": before.plot.building.layout_revision,
            "content": content,
        }))
        .transact()
        .await?;
    ensure!(proposed.is_success(), "proposal failed: {proposed:?}");
    let proposal: MediaProposal = proposed.json()?;

    let secret = SecretKey::from_random(KeyType::ED25519);
    let public = secret.public_key();
    let add_key = moderator
        .batch(moderator.id())
        .add_key(
            public.clone(),
            AccessKey::function_call_access(
                contract.id(),
                &METHODS,
                Some(NearToken::from_yoctonear(ALLOWANCE_YOCTO)),
            ),
        )
        .transact()
        .await?;
    ensure!(add_key.is_success(), "key creation failed: {add_key:?}");
    let restricted = Account::from_secret_key(moderator.id().clone(), secret, &worker);
    let forbidden = restricted
        .call(contract.id(), "seed_plot")
        .args_json(json!({"seed": PlotSeed {
            road_id: RoadId::Main,
            side: Side::North,
            index: 1,
            building_type: BuildingType::Retail,
            variant: 1,
        }}))
        .transact()
        .await;
    ensure!(
        !matches!(forbidden, Ok(ref outcome) if outcome.is_success()),
        "restricted key invoked an unlisted method"
    );
    let approved = restricted
        .call(contract.id(), "approve_media")
        .args_json(json!({"plot_id": PLOT_ID, "kind": MediaKind::Logo, "expected": proposal}))
        .transact()
        .await?;
    ensure!(approved.is_success(), "approval failed: {approved:?}");
    let active: PlotView = contract
        .view("get_plot")
        .args_json(json!({"plot_id": PLOT_ID}))
        .await?
        .json()?;
    ensure!(active.plot.logo.active.as_ref().map(|entry| &entry.content) == Some(&content));
    ensure!(
        active.plot.logo.last_decision.as_ref().map(|d| d.status)
            == Some(MediaDecisionStatus::Approved)
    );
    let access = moderator.view_access_key(&public).await?;
    let AccessKeyPermission::FunctionCall(permission) = access.permission else {
        anyhow::bail!("moderator key became full access")
    };
    ensure!(permission.receiver_id == contract.id().as_str());
    ensure!(
        permission
            .method_names
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
            == METHODS
    );
    ensure!(permission.allowance.is_some_and(|remaining| {
        remaining.as_yoctonear() > 0 && remaining.as_yoctonear() < ALLOWANCE_YOCTO
    }));

    let replacement_secret = SecretKey::from_random(KeyType::ED25519);
    let replacement_public = replacement_secret.public_key();
    let add_replacement = moderator
        .batch(moderator.id())
        .add_key(
            replacement_public.clone(),
            AccessKey::function_call_access(
                contract.id(),
                &METHODS,
                Some(NearToken::from_yoctonear(ALLOWANCE_YOCTO)),
            ),
        )
        .transact()
        .await?;
    ensure!(
        add_replacement.is_success(),
        "replacement key creation failed: {add_replacement:?}"
    );
    let replacement_access = moderator.view_access_key(&replacement_public).await?;
    let AccessKeyPermission::FunctionCall(replacement_permission) = replacement_access.permission
    else {
        anyhow::bail!("replacement moderator key became full access")
    };
    ensure!(
        replacement_permission.receiver_id == contract.id().as_str()
            && replacement_permission
                .method_names
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
                == METHODS
            && replacement_permission
                .allowance
                .is_some_and(|allowance| { allowance.as_yoctonear() == ALLOWANCE_YOCTO }),
        "replacement key scope differs from the moderation policy"
    );
    let overlapping_keys = moderator.view_access_keys().await?;
    ensure!(
        overlapping_keys
            .iter()
            .any(|entry| entry.public_key == public)
            && overlapping_keys
                .iter()
                .any(|entry| entry.public_key == replacement_public),
        "old and replacement keys did not overlap on-chain"
    );
    let remove_old_key = moderator
        .batch(moderator.id())
        .delete_key(public.clone())
        .transact()
        .await?;
    ensure!(
        remove_old_key.is_success(),
        "old key removal failed: {remove_old_key:?}"
    );
    ensure!(!moderator
        .view_access_keys()
        .await?
        .iter()
        .any(|entry| entry.public_key == public));
    let rejected_old_key = restricted
        .call(contract.id(), "revoke_media")
        .args_json(json!({
            "plot_id": PLOT_ID,
            "kind": MediaKind::Logo,
            "expected_media_revision": proposal.revision,
            "expected_content": content,
            "reason": "Old key must not revoke content"
        }))
        .transact()
        .await;
    ensure!(
        !matches!(rejected_old_key, Ok(ref outcome) if outcome.is_success()),
        "removed moderator key still signed a revocation"
    );
    let after_old_key_attempt: PlotView = contract
        .view("get_plot")
        .args_json(json!({"plot_id": PLOT_ID}))
        .await?
        .json()?;
    ensure!(
        after_old_key_attempt
            .plot
            .logo
            .active
            .as_ref()
            .map(|entry| &entry.content)
            == Some(&content),
        "removed key changed active content"
    );
    let replacement = Account::from_secret_key(moderator.id().clone(), replacement_secret, &worker);
    let revoked = replacement
        .call(contract.id(), "revoke_media")
        .args_json(json!({
            "plot_id": PLOT_ID,
            "kind": MediaKind::Logo,
            "expected_media_revision": proposal.revision,
            "expected_content": content,
            "reason": "Sandbox moderation journey complete"
        }))
        .transact()
        .await?;
    ensure!(revoked.is_success(), "revocation failed: {revoked:?}");
    let cleared: PlotView = contract
        .view("get_plot")
        .args_json(json!({"plot_id": PLOT_ID}))
        .await?
        .json()?;
    ensure!(cleared.plot.logo.active.is_none());
    ensure!(cleared.plot.logo.revision == proposal.revision + 1);
    ensure!(
        cleared.plot.logo.last_decision.as_ref().map(|d| d.status)
            == Some(MediaDecisionStatus::Revoked)
    );
    let remove_key = moderator
        .batch(moderator.id())
        .delete_key(replacement_public.clone())
        .transact()
        .await?;
    ensure!(
        remove_key.is_success(),
        "key cleanup failed: {remove_key:?}"
    );
    ensure!(!moderator
        .view_access_keys()
        .await?
        .iter()
        .any(|entry| entry.public_key == replacement_public));

    let mut config: Value = contract.view("get_config").await?.json()?;
    config["version"] = json!(2);
    config["rule_delay_seconds"] = json!(0);
    config["inspector_min_age_seconds"] = json!(0);
    config["inspector_chance_bps"] = json!(0);
    let updated = contract
        .call("update_config")
        .args_json(json!({"config": config}))
        .transact()
        .await?;
    ensure!(
        updated.is_success(),
        "inspection config failed: {updated:?}"
    );
    let forbidden_rule = owner
        .call(contract.id(), "set_rule")
        .args_json(json!({"plot_id": PLOT_ID, "rule": {"kind": "NoParking"}}))
        .transact()
        .await?;
    ensure!(
        forbidden_rule.is_success(),
        "NoParking rule failed: {forbidden_rule:?}"
    );
    let first_park = driver
        .call(contract.id(), "park")
        .args_json(json!({"car_id": car_id, "plot_id": PLOT_ID, "slot": 0}))
        .transact()
        .await?;
    ensure!(
        first_park.is_success(),
        "illegal park failed: {first_park:?}"
    );
    let first_session: Value = first_park.json()?;
    ensure!(first_session["legal"] == false, "park was not illegal");

    let old_inspector_secret = SecretKey::from_random(KeyType::ED25519);
    let old_inspector_public = old_inspector_secret.public_key();
    let add_old_inspector = inspector
        .batch(inspector.id())
        .add_key(
            old_inspector_public.clone(),
            AccessKey::function_call_access(
                contract.id(),
                &["inspect"],
                Some(NearToken::from_yoctonear(INSPECTOR_ALLOWANCE_YOCTO)),
            ),
        )
        .transact()
        .await?;
    ensure!(
        add_old_inspector.is_success(),
        "old inspector key creation failed: {add_old_inspector:?}"
    );
    let old_inspector =
        Account::from_secret_key(inspector.id().clone(), old_inspector_secret, &worker);
    let first_inspection = old_inspector
        .call(contract.id(), "inspect")
        .args_json(json!({
            "plot_id": PLOT_ID,
            "slot": 0,
            "expected_session_id": first_session["id"]
        }))
        .transact()
        .await?;
    ensure!(
        first_inspection.is_success(),
        "old inspector key failed a patrol: {first_inspection:?}"
    );
    let first_attempted: Value = contract
        .view("get_session")
        .args_json(json!({"session_id": first_session["id"]}))
        .await?
        .json()?;
    ensure!(
        first_attempted["inspector_attempted"] == true,
        "first patrol was not recorded"
    );

    let new_inspector_secret = SecretKey::from_random(KeyType::ED25519);
    let new_inspector_public = new_inspector_secret.public_key();
    let add_new_inspector = inspector
        .batch(inspector.id())
        .add_key(
            new_inspector_public.clone(),
            AccessKey::function_call_access(
                contract.id(),
                &["inspect"],
                Some(NearToken::from_yoctonear(INSPECTOR_ALLOWANCE_YOCTO)),
            ),
        )
        .transact()
        .await?;
    ensure!(
        add_new_inspector.is_success(),
        "new inspector key creation failed: {add_new_inspector:?}"
    );
    let new_inspector_access = inspector.view_access_key(&new_inspector_public).await?;
    let AccessKeyPermission::FunctionCall(new_inspector_permission) =
        new_inspector_access.permission
    else {
        anyhow::bail!("replacement inspector key became full access")
    };
    ensure!(
        new_inspector_permission.receiver_id == contract.id().as_str()
            && new_inspector_permission.method_names == ["inspect"]
            && new_inspector_permission
                .allowance
                .is_some_and(|amount| amount.as_yoctonear() == INSPECTOR_ALLOWANCE_YOCTO),
        "replacement inspector key has the wrong scope"
    );
    let overlapping_inspector_keys = inspector.view_access_keys().await?;
    ensure!(
        overlapping_inspector_keys
            .iter()
            .any(|entry| entry.public_key == old_inspector_public)
            && overlapping_inspector_keys
                .iter()
                .any(|entry| entry.public_key == new_inspector_public),
        "inspector keys did not overlap on-chain"
    );
    let remove_old_inspector = inspector
        .batch(inspector.id())
        .delete_key(old_inspector_public.clone())
        .transact()
        .await?;
    ensure!(
        remove_old_inspector.is_success(),
        "old inspector key removal failed: {remove_old_inspector:?}"
    );
    ensure!(!inspector
        .view_access_keys()
        .await?
        .iter()
        .any(|entry| entry.public_key == old_inspector_public));

    let collect = driver
        .call(contract.id(), "collect")
        .args_json(json!({"expected_session_id": first_session["id"]}))
        .transact()
        .await?;
    ensure!(
        collect.is_success(),
        "old session collection failed: {collect:?}"
    );
    let second_park = driver
        .call(contract.id(), "park")
        .args_json(json!({"car_id": car_id, "plot_id": PLOT_ID, "slot": 0}))
        .transact()
        .await?;
    ensure!(
        second_park.is_success(),
        "second illegal park failed: {second_park:?}"
    );
    let second_session: Value = second_park.json()?;
    ensure!(
        second_session["legal"] == false,
        "second park was not illegal"
    );
    let old_inspection = old_inspector
        .call(contract.id(), "inspect")
        .args_json(json!({
            "plot_id": PLOT_ID,
            "slot": 0,
            "expected_session_id": second_session["id"]
        }))
        .transact()
        .await;
    ensure!(
        !matches!(old_inspection, Ok(ref outcome) if outcome.is_success()),
        "removed inspector key still made a patrol attempt"
    );
    let before_new_inspection: Value = contract
        .view("get_session")
        .args_json(json!({"session_id": second_session["id"]}))
        .await?
        .json()?;
    ensure!(
        before_new_inspection["inspector_attempted"] == false,
        "removed key consumed the new inspection attempt"
    );
    let new_inspector =
        Account::from_secret_key(inspector.id().clone(), new_inspector_secret, &worker);
    let second_inspection = new_inspector
        .call(contract.id(), "inspect")
        .args_json(json!({
            "plot_id": PLOT_ID,
            "slot": 0,
            "expected_session_id": second_session["id"]
        }))
        .transact()
        .await?;
    ensure!(
        second_inspection.is_success(),
        "replacement inspector key failed a patrol: {second_inspection:?}"
    );
    let second_attempted: Value = contract
        .view("get_session")
        .args_json(json!({"session_id": second_session["id"]}))
        .await?
        .json()?;
    ensure!(
        second_attempted["inspector_attempted"] == true,
        "replacement inspector patrol was not recorded"
    );
    let remove_new_inspector = inspector
        .batch(inspector.id())
        .delete_key(new_inspector_public.clone())
        .transact()
        .await?;
    ensure!(
        remove_new_inspector.is_success(),
        "replacement inspector key cleanup failed: {remove_new_inspector:?}"
    );
    ensure!(!inspector
        .view_access_keys()
        .await?
        .iter()
        .any(|entry| entry.public_key == new_inspector_public));
    Ok(())
}
