use near_sdk::serde_json::{json, Value};
use near_workspaces::types::NearToken;
use std::path::PathBuf;

fn wasm_path() -> PathBuf {
    std::env::var_os("ESTATE_WASM")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../target/wasm32-unknown-unknown/release/near_estate_contract.wasm")
        })
}

#[tokio::test]
async fn paid_registration_plot_rules_and_ticket_settle_on_sandbox() -> anyhow::Result<()> {
    let wasm = std::fs::read(wasm_path())?;
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm).await?;
    let moderator = worker.dev_create_account().await?;
    let inspector = worker.dev_create_account().await?;
    let owner_parent = worker.dev_create_account().await?;
    let owner_label = "a".repeat(63 - owner_parent.id().as_str().len());
    let owner = owner_parent
        .create_subaccount(&owner_label)
        .initial_balance(NearToken::from_near(20))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(owner.id().as_str().len(), 64);
    let driver = worker.dev_create_account().await?;
    let rival = worker.dev_create_account().await?;

    let hijack = owner
        .call(contract.id(), "new")
        .args_json(json!({
            "admin": owner.id(),
            "moderator": moderator.id(),
            "inspector": inspector.id(),
        }))
        .transact()
        .await?;
    assert!(
        !hijack.is_success(),
        "an outside account initialized the contract"
    );

    let init = contract
        .call("new")
        .args_json(json!({
            "admin": contract.id(),
            "moderator": moderator.id(),
            "inspector": inspector.id(),
        }))
        .transact()
        .await?;
    assert!(init.is_success(), "initialization failed: {init:?}");

    let seed = contract
        .call("seed_plot")
        .args_json(json!({"seed": {
            "road_id": "main", "side": "North", "index": 0,
            "building_type": "Retail", "variant": 1
        }}))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?;
    assert!(seed.is_success(), "plot seed failed: {seed:?}");

    let seeded_storage = contract.view_account().await?.storage_usage;
    let registration_quote: String = contract.call("registration_quote").view().await?.json()?;
    let mut previous_storage = seeded_storage;
    for player in [&owner, &driver, &rival] {
        let registration = player
            .call(contract.id(), "register_player")
            .args_json(json!({"body": "Hatchback", "color": "Red"}))
            .deposit(NearToken::from_yoctonear(registration_quote.parse()?))
            .transact()
            .await?;
        assert!(
            registration.is_success(),
            "registration failed: {registration:?}"
        );
        let usage = contract.view_account().await?.storage_usage;
        assert!(usage > previous_storage, "registration must store a player");
        assert!(
            usage - previous_storage <= 4_096,
            "registration exceeded storage reserve"
        );
        previous_storage = usage;
    }

    let breakdown: Value = contract
        .call("plot_purchase_breakdown")
        .args_json(json!({"plot_id": "plot-main-n-0"}))
        .view()
        .await?
        .json()?;
    let price: u128 = breakdown["price_yocto"]
        .as_str()
        .unwrap_or_default()
        .parse()?;
    let reserve: u128 = breakdown["storage_reserve_yocto"]
        .as_str()
        .unwrap_or_default()
        .parse()?;
    let total: u128 = breakdown["total_yocto"]
        .as_str()
        .unwrap_or_default()
        .parse()?;
    assert_eq!(price + reserve, total);
    let purchase = owner
        .call(contract.id(), "buy_plot")
        .args_json(json!({"plot_id": "plot-main-n-0"}))
        .deposit(NearToken::from_yoctonear(total))
        .transact()
        .await?;
    assert!(purchase.is_success(), "plot purchase failed: {purchase:?}");
    let purchased_storage = contract.view_account().await?.storage_usage;
    assert!(
        purchased_storage > previous_storage,
        "purchase must update plot storage"
    );
    assert!(
        purchased_storage - previous_storage <= 4_096,
        "plot purchase exceeded storage reserve"
    );

    let rule = owner
        .call(contract.id(), "set_rule")
        .args_json(json!({"plot_id": "plot-main-n-0", "rule": {"kind": "NoParking"}}))
        .transact()
        .await?;
    assert!(rule.is_success(), "rule update failed: {rule:?}");
    let pending: Value = contract
        .call("get_plot")
        .args_json(json!({"plot_id": "plot-main-n-0"}))
        .view()
        .await?
        .json()?;
    let effective_at = pending["plot"]["pending_rule"]["effective_at"]
        .as_u64()
        .expect("rule effective time");
    worker.fast_forward(1_200).await?;
    let after_time: u64 = contract.call("chain_time_seconds").view().await?.json()?;
    assert!(
        after_time >= effective_at,
        "sandbox clock did not reach rule activation"
    );
    let plot_after_delay: Value = contract
        .call("get_plot")
        .args_json(json!({"plot_id": "plot-main-n-0"}))
        .view()
        .await?
        .json()?;
    assert_eq!(plot_after_delay["effective_rule"]["kind"], "NoParking");

    let parked = driver
        .call(contract.id(), "park")
        .args_json(json!({"car_id": 2, "plot_id": "plot-main-n-0", "slot": 0}))
        .transact()
        .await?;
    assert!(parked.is_success(), "parking failed: {parked:?}");
    let session: Value = parked.json()?;
    assert_eq!(session["legal"], false);
    let session_id = session["id"].as_u64().expect("numeric session ID");
    let street: Value = contract
        .call("get_street_side")
        .args_json(json!({"road_id": "main", "side": "North"}))
        .view()
        .await?
        .json()?;
    assert_eq!(street["road_id"], "main");
    assert_eq!(street["side"], "North");
    assert_eq!(street["plots"][0]["plot"]["plot"]["id"], "plot-main-n-0");
    assert_eq!(street["plots"][0]["slots"][0]["id"], session_id);
    assert!(street["plots"][0]["slots"][1].is_null());
    assert_eq!(street["plots"][0]["car_appearances"][0]["id"], 2);
    assert_eq!(
        street["plots"][0]["car_appearances"][0]["body"],
        "Hatchback"
    );
    assert_eq!(street["plots"][0]["car_appearances"][0]["color"], "Red");
    assert!(street["plots"][0]["car_appearances"][1].is_null());

    let ticket = owner
        .call(contract.id(), "ticket")
        .args_json(json!({
            "plot_id": "plot-main-n-0", "slot": 0,
            "expected_session_id": session_id
        }))
        .transact()
        .await?;
    assert!(ticket.is_success(), "ticket failed: {ticket:?}");
    let settled: Value = ticket.json()?;
    assert_eq!(settled["driver_payout"], "0");

    let space: Value = contract
        .call("get_space_session")
        .args_json(json!({"plot_id": "plot-main-n-0", "slot": 0}))
        .view()
        .await?
        .json()?;
    assert!(space.is_null(), "ticket must release the curb");
    let street_after_ticket: Value = contract
        .call("get_street_side")
        .args_json(json!({"road_id": "main", "side": "North"}))
        .view()
        .await?
        .json()?;
    assert!(street_after_ticket["plots"][0]["slots"][0].is_null());
    assert!(street_after_ticket["plots"][0]["car_appearances"][0].is_null());
    let duplicate = owner
        .call(contract.id(), "ticket")
        .args_json(json!({
            "plot_id": "plot-main-n-0", "slot": 0,
            "expected_session_id": session_id
        }))
        .transact()
        .await?;
    assert!(duplicate.is_failure(), "settlement must not run twice");

    let mut short_session_config: Value = contract.call("get_config").view().await?.json()?;
    short_session_config["version"] = json!(2);
    short_session_config["earn_cap_seconds"] = json!(60);
    short_session_config["expiry_grace_seconds"] = json!(0);
    let shortened = contract
        .call("update_config")
        .args_json(json!({"config": short_session_config}))
        .transact()
        .await?;
    assert!(
        shortened.is_success(),
        "short session config failed: {shortened:?}"
    );

    let old = driver
        .call(contract.id(), "park")
        .args_json(json!({"car_id": 2, "plot_id": "plot-main-n-0", "slot": 1}))
        .transact()
        .await?;
    assert!(old.is_success(), "second parking failed: {old:?}");
    let old_session: Value = old.json()?;
    let old_id = old_session["id"].as_u64().expect("numeric session ID");
    let contested = rival
        .call(contract.id(), "park")
        .args_json(json!({"car_id": 3, "plot_id": "plot-main-n-0", "slot": 1}))
        .transact()
        .await?;
    assert!(
        contested.is_failure(),
        "occupied curb must reject a rival car"
    );
    assert!(
        format!("{contested:?}").contains("parking space is occupied"),
        "occupied curb must report the contract error: {contested:?}"
    );
    worker.fast_forward(400).await?;
    let after_expiry: u64 = contract.call("chain_time_seconds").view().await?.json()?;
    assert!(
        after_expiry >= old_session["expires_at"].as_u64().expect("expiry time"),
        "sandbox clock did not reach parking expiry"
    );
    let replacement = rival
        .call(contract.id(), "park")
        .args_json(json!({"car_id": 3, "plot_id": "plot-main-n-0", "slot": 1}))
        .transact()
        .await?;
    assert!(
        replacement.is_success(),
        "expired space was not reused: {replacement:?}"
    );
    let old_after_reuse: Value = contract
        .call("get_session")
        .args_json(json!({"session_id": old_id}))
        .view()
        .await?
        .json()?;
    assert!(
        old_after_reuse.is_null(),
        "old session must settle on reuse"
    );
    let settle_twice = driver
        .call(contract.id(), "settle_expired")
        .args_json(json!({"expected_session_id": old_id}))
        .transact()
        .await?;
    assert!(
        settle_twice.is_failure(),
        "expired session must not pay twice"
    );

    let max_link = format!("https://example.com/{}", "x".repeat(236));
    assert_eq!(max_link.len(), 256);
    let logo = json!({"asset_hash": "a".repeat(64), "link": max_link});
    let proposed = owner
        .call(contract.id(), "propose_media")
        .args_json(json!({
            "plot_id": "plot-main-n-0", "kind": "Logo",
            "expected_media_revision": 0, "expected_layout_revision": 1,
            "content": logo
        }))
        .transact()
        .await?;
    assert!(proposed.is_success(), "media proposal failed: {proposed:?}");
    let proposal: Value = proposed.json()?;

    let unauthorized = driver
        .call(contract.id(), "approve_media")
        .args_json(json!({
            "plot_id": "plot-main-n-0", "kind": "Logo", "expected": proposal
        }))
        .transact()
        .await?;
    assert!(
        unauthorized.is_failure(),
        "only the moderator can approve media"
    );

    let approved = moderator
        .call(contract.id(), "approve_media")
        .args_json(json!({
            "plot_id": "plot-main-n-0", "kind": "Logo", "expected": proposal
        }))
        .transact()
        .await?;
    assert!(approved.is_success(), "media approval failed: {approved:?}");
    let first_approval: Value = approved.json()?;
    assert_eq!(first_approval["logo_eligible"], true);
    let replacement_at = first_approval["plot"]["logo"]["last_replacement_at"].clone();

    let preset = owner
        .call(contract.id(), "choose_preset")
        .args_json(json!({
            "plot_id": "plot-main-n-0", "variant": 2,
            "primary_color": "#F6C85F", "name": "🔥".repeat(24)
        }))
        .transact()
        .await?;
    assert!(preset.is_success(), "preset update failed: {preset:?}");
    let stale_layout: Value = contract
        .call("get_plot")
        .args_json(json!({"plot_id": "plot-main-n-0"}))
        .view()
        .await?
        .json()?;
    assert_eq!(stale_layout["logo_eligible"], false);
    assert_eq!(stale_layout["plot"]["building"]["layout_revision"], 2);
    let first_facade = owner
        .call(contract.id(), "propose_appearance")
        .args_json(json!({
            "plot_id": "plot-main-n-0", "expected_revision": 2,
            "manifest_hash": "9".repeat(64)
        }))
        .transact()
        .await?;
    assert!(
        first_facade.is_success(),
        "facade proposal failed: {first_facade:?}"
    );
    let first_facade_ref: Value = first_facade.json()?;
    let first_facade_approval = moderator
        .call(contract.id(), "approve_appearance")
        .args_json(json!({"plot_id": "plot-main-n-0", "expected": first_facade_ref}))
        .transact()
        .await?;
    assert!(
        first_facade_approval.is_success(),
        "first facade approval failed: {first_facade_approval:?}"
    );

    let revalidation = owner
        .call(contract.id(), "propose_media")
        .args_json(json!({
            "plot_id": "plot-main-n-0", "kind": "Logo",
            "expected_media_revision": 1, "expected_layout_revision": 3,
            "content": logo
        }))
        .transact()
        .await?;
    assert!(
        revalidation.is_success(),
        "revalidation proposal failed: {revalidation:?}"
    );
    let revalidation_proposal: Value = revalidation.json()?;
    let reapproved = moderator
        .call(contract.id(), "approve_media")
        .args_json(json!({
            "plot_id": "plot-main-n-0", "kind": "Logo",
            "expected": revalidation_proposal
        }))
        .transact()
        .await?;
    assert!(
        reapproved.is_success(),
        "media reapproval failed: {reapproved:?}"
    );
    let second_approval: Value = reapproved.json()?;
    assert_eq!(second_approval["logo_eligible"], true);
    assert_eq!(
        second_approval["plot"]["logo"]["last_replacement_at"], replacement_at,
        "unchanged content must not reset the replacement timer"
    );
    let final_storage = contract.view_account().await?.storage_usage;
    assert!(
        final_storage - purchased_storage <= 4_096,
        "post-purchase state growth exceeded the plot storage reserve"
    );
    println!(
        "storage bytes: seed={seeded_storage}, three players={previous_storage}, purchase={purchased_storage}, final={final_storage}"
    );

    let billboard = owner
        .call(contract.id(), "propose_media")
        .args_json(json!({
            "plot_id": "plot-main-n-0", "kind": "Billboard",
            "expected_media_revision": 0, "expected_layout_revision": 3,
            "content": {"asset_hash": "b".repeat(64), "link": max_link}
        }))
        .transact()
        .await?;
    assert!(
        billboard.is_success(),
        "billboard proposal failed: {billboard:?}"
    );
    let billboard_proposal: Value = billboard.json()?;
    let billboard_approval = moderator
        .call(contract.id(), "approve_media")
        .args_json(json!({
            "plot_id": "plot-main-n-0", "kind": "Billboard",
            "expected": billboard_proposal
        }))
        .transact()
        .await?;
    assert!(billboard_approval.is_success(), "billboard approval failed");

    for (kind, revision, rejected_hash, pending_hash) in
        [("Logo", 2, 'c', 'e'), ("Billboard", 1, 'd', 'f')]
    {
        let rejected = owner
            .call(contract.id(), "propose_media")
            .args_json(json!({
                "plot_id": "plot-main-n-0", "kind": kind,
                "expected_media_revision": revision, "expected_layout_revision": 3,
                "content": {"asset_hash": rejected_hash.to_string().repeat(64), "link": max_link}
            }))
            .transact()
            .await?;
        assert!(
            rejected.is_success(),
            "maximal media proposal failed: {rejected:?}"
        );
        let rejected_proposal: Value = rejected.json()?;
        let decision = moderator
            .call(contract.id(), "reject_media")
            .args_json(json!({
                "plot_id": "plot-main-n-0", "kind": kind,
                "expected": rejected_proposal, "reason": "🔥".repeat(60)
            }))
            .transact()
            .await?;
        assert!(
            decision.is_success(),
            "maximal rejection failed: {decision:?}"
        );
        let pending = owner
            .call(contract.id(), "propose_media")
            .args_json(json!({
                "plot_id": "plot-main-n-0", "kind": kind,
                "expected_media_revision": revision + 1, "expected_layout_revision": 3,
                "content": {"asset_hash": pending_hash.to_string().repeat(64), "link": max_link}
            }))
            .transact()
            .await?;
        assert!(
            pending.is_success(),
            "maximal pending proposal failed: {pending:?}"
        );
    }
    let facade = owner
        .call(contract.id(), "propose_appearance")
        .args_json(json!({
            "plot_id": "plot-main-n-0", "expected_revision": 3,
            "manifest_hash": "a".repeat(64)
        }))
        .transact()
        .await?;
    assert!(facade.is_success(), "facade proposal failed: {facade:?}");
    let next_rule = owner
        .call(contract.id(), "set_rule")
        .args_json(json!({"plot_id": "plot-main-n-0", "rule": {"kind": "Free"}}))
        .transact()
        .await?;
    assert!(next_rule.is_success(), "pending rule failed: {next_rule:?}");
    let maximal: Value = contract
        .call("get_plot")
        .args_json(json!({"plot_id": "plot-main-n-0"}))
        .view()
        .await?
        .json()?;
    let used = maximal["plot"]["used_storage_bytes"]
        .as_u64()
        .expect("plot storage usage");
    let reserved = maximal["plot"]["reserved_storage_bytes"]
        .as_u64()
        .expect("plot storage reserve");
    assert!(
        used <= reserved,
        "maximal plot state exceeded prepaid storage"
    );
    assert!(maximal["plot"]["logo"]["pending"].is_object());
    assert!(maximal["plot"]["billboard"]["pending"].is_object());
    println!("maximal plot storage bytes: used={used}, reserved={reserved}");
    let rejected_facade = moderator
        .call(contract.id(), "reject_appearance")
        .args_json(json!({
            "plot_id": "plot-main-n-0",
            "expected": maximal["plot"]["building"]["pending_appearance"],
            "reason": "🔥".repeat(60)
        }))
        .transact()
        .await?;
    assert!(
        rejected_facade.is_success(),
        "long facade rejection exceeded plot storage: {rejected_facade:?}"
    );
    let rejected_plot: Value = contract
        .call("get_plot")
        .args_json(json!({"plot_id": "plot-main-n-0"}))
        .view()
        .await?
        .json()?;
    let rejected_used = rejected_plot["plot"]["used_storage_bytes"]
        .as_u64()
        .expect("rejected plot storage usage");
    assert!(rejected_used <= reserved);
    assert_eq!(
        rejected_plot["plot"]["building"]["last_appearance_decision"]["reason"]
            .as_str()
            .map(str::len),
        Some(240)
    );
    println!("rejected plot storage bytes: used={rejected_used}, reserved={reserved}");
    let revoked_facade = moderator
        .call(contract.id(), "revoke_appearance")
        .args_json(json!({
            "plot_id": "plot-main-n-0",
            "expected_revision": rejected_plot["plot"]["building"]["appearance_revision"],
            "expected_manifest_hash": rejected_plot["plot"]["building"]["approved_manifest_hash"],
            "reason": "🔥".repeat(60)
        }))
        .transact()
        .await?;
    assert!(
        revoked_facade.is_success(),
        "revocation of crowded plot failed: {revoked_facade:?}"
    );
    let revoked_plot: Value = contract
        .call("get_plot")
        .args_json(json!({"plot_id": "plot-main-n-0"}))
        .view()
        .await?
        .json()?;
    let revoked_used = revoked_plot["plot"]["used_storage_bytes"]
        .as_u64()
        .expect("revoked plot storage usage");
    assert!(revoked_used <= reserved);
    assert!(revoked_plot["plot"]["building"]["approved_manifest_hash"].is_null());
    println!("revoked plot storage bytes: used={revoked_used}, reserved={reserved}");

    let mut cheap_cars: Value = contract.call("get_config").view().await?.json()?;
    cheap_cars["version"] = json!(3);
    cheap_cars["buy_car_cost"] = json!("0");
    let config_change = contract
        .call("update_config")
        .args_json(json!({"config": cheap_cars}))
        .transact()
        .await?;
    assert!(
        config_change.is_success(),
        "test config failed: {config_change:?}"
    );
    for color in ["Blue", "Yellow"] {
        let purchase = owner
            .call(contract.id(), "buy_car")
            .args_json(json!({"body": "Sedan", "color": color}))
            .transact()
            .await?;
        assert!(
            purchase.is_success(),
            "max-length owner's car purchase failed: {purchase:?}"
        );
    }
    let free_plot = contract
        .call("seed_plot")
        .args_json(json!({"seed": {
            "road_id": "main", "side": "North", "index": 1,
            "building_type": "Cafe", "variant": 1
        }}))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?;
    assert!(
        free_plot.is_success(),
        "second plot seed failed: {free_plot:?}"
    );
    let account: Value = contract
        .call("get_account")
        .args_json(json!({"account_id": owner.id()}))
        .view()
        .await?
        .json()?;
    assert_eq!(account["car_ids"].as_array().map(Vec::len), Some(3));
    let car_id = account["car_ids"][2].as_u64().expect("third car ID");
    let parking = owner
        .call(contract.id(), "park")
        .args_json(json!({"car_id": car_id, "plot_id": "plot-main-n-1", "slot": 0}))
        .transact()
        .await?;
    assert!(
        parking.is_success(),
        "max-length owner's parking failed: {parking:?}"
    );
    let parked_account: Value = contract
        .call("get_account")
        .args_json(json!({"account_id": owner.id()}))
        .view()
        .await?
        .json()?;
    let account_used = parked_account["used_storage_bytes"]
        .as_u64()
        .expect("account storage usage");
    let account_reserved = parked_account["reserved_storage_bytes"]
        .as_u64()
        .expect("account storage reserve");
    assert!(
        account_used <= account_reserved,
        "three-car account exceeded prepaid storage"
    );
    println!("maximal account storage bytes: used={account_used}, reserved={account_reserved}");
    Ok(())
}
