use anyhow::{ensure, Result};
use near_estate_contract::{
    BuildingType, CarBody, CarColor, MediaDecisionStatus, MediaIdentity, MediaKind, MediaProposal,
    PlotSeed, PlotView, RoadId, Side,
};
use near_sdk::{json_types::U128, serde_json::json};
use near_workspaces::{
    types::{AccessKey, AccessKeyPermission, KeyType, NearToken, SecretKey},
    Account,
};
use std::path::PathBuf;

const PLOT_ID: &str = "plot-main-n-0";
const ALLOWANCE_YOCTO: u128 = 500_000_000_000_000_000_000_000;
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
async fn restricted_moderator_approves_and_revokes_logo_on_sandbox() -> Result<()> {
    let wasm = std::fs::read(wasm_path())?;
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm).await?;
    let moderator = worker.dev_create_account().await?;
    let inspector = worker.dev_create_account().await?;
    let owner = worker.dev_create_account().await?;

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

    let revoked = restricted
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
        .delete_key(public.clone())
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
        .any(|entry| entry.public_key == public));
    Ok(())
}
