use near_sdk::serde_json::{json, Value};
use near_workspaces::{result::ExecutionFinalResult, types::NearToken, Account, Contract};
use std::path::PathBuf;

fn wasm_path() -> PathBuf {
    std::env::var_os("ESTATE_WASM")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../target/wasm32-unknown-unknown/release/near_estate_contract.wasm")
        })
}

async fn balance(contract: &Contract, player: &Account) -> anyhow::Result<u128> {
    let account: Value = contract
        .call("get_account")
        .args_json(json!({"account_id": player.id()}))
        .view()
        .await?
        .json()?;
    Ok(account["balance"].as_str().unwrap_or_default().parse()?)
}

fn amount(value: &Value, key: &str) -> anyhow::Result<u128> {
    Ok(value[key].as_str().unwrap_or_default().parse()?)
}

fn emitted(result: &ExecutionFinalResult, expected: &str) -> anyhow::Result<Value> {
    for log in result.logs() {
        if let Some(raw) = log.strip_prefix("EVENT_JSON:") {
            let event: Value = near_sdk::serde_json::from_str(raw)?;
            if event["event"] == expected {
                assert_eq!(event["standard"], "near_estate");
                assert_eq!(event["version"], "1.0.0");
                assert_eq!(event["data"].as_array().map(Vec::len), Some(1));
                return Ok(event["data"][0].clone());
            }
        }
    }
    Err(anyhow::anyhow!("missing {expected} event"))
}

fn event_count(result: &ExecutionFinalResult, expected: &str) -> anyhow::Result<usize> {
    let mut count = 0;
    for log in result.logs() {
        if let Some(raw) = log.strip_prefix("EVENT_JSON:") {
            let event: Value = near_sdk::serde_json::from_str(raw)?;
            if event["event"] == expected {
                count += event["data"].as_array().map(Vec::len).unwrap_or_default();
            }
        }
    }
    Ok(count)
}

#[tokio::test]
async fn sandbox_meter_inspector_and_competing_settlements() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&std::fs::read(wasm_path())?).await?;
    let moderator = worker.dev_create_account().await?;
    let inspector = worker.dev_create_account().await?;
    let owner = worker.dev_create_account().await?;
    let driver = worker.dev_create_account().await?;
    let rival = worker.dev_create_account().await?;
    let init = contract
        .call("new")
        .args_json(json!({
            "admin": contract.id(), "moderator": moderator.id(),
            "inspector": inspector.id()
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
    assert!(seed.is_success(), "seed failed: {seed:?}");

    let quote: String = contract.call("registration_quote").view().await?.json()?;
    let mut car_ids = Vec::new();
    for player in [&owner, &driver, &rival] {
        let registration = player
            .call(contract.id(), "register_player")
            .args_json(json!({"body": "Hatchback", "color": "Red"}))
            .deposit(NearToken::from_yoctonear(quote.parse()?))
            .transact()
            .await?;
        assert!(
            registration.is_success(),
            "registration failed: {registration:?}"
        );
        let car: Value = registration.json()?;
        car_ids.push(car["id"].as_u64().expect("registered car ID"));
    }
    let breakdown: Value = contract
        .call("plot_purchase_breakdown")
        .args_json(json!({"plot_id": "plot-main-n-0"}))
        .view()
        .await?
        .json()?;
    let purchase = owner
        .call(contract.id(), "buy_plot")
        .args_json(json!({"plot_id": "plot-main-n-0"}))
        .deposit(NearToken::from_yoctonear(amount(
            &breakdown,
            "total_yocto",
        )?))
        .transact()
        .await?;
    assert!(purchase.is_success(), "purchase failed: {purchase:?}");

    let mut config: Value = contract.call("get_config").view().await?.json()?;
    config["version"] = json!(2);
    config["rule_delay_seconds"] = json!(0);
    config["inspector_min_age_seconds"] = json!(60);
    config["inspector_chance_bps"] = json!(0);
    config["inspector_max_attempts_per_window"] = json!(1);
    let updated = contract
        .call("update_config")
        .args_json(json!({"config": config}))
        .transact()
        .await?;
    assert!(updated.is_success(), "config update failed: {updated:?}");
    let meter = owner
        .call(contract.id(), "set_rule")
        .args_json(json!({
            "plot_id": "plot-main-n-0",
            "rule": {"kind": "Meter", "ratePerHour": "30000000"}
        }))
        .transact()
        .await?;
    assert!(meter.is_success(), "meter rule failed: {meter:?}");

    let parked = driver
        .call(contract.id(), "park")
        .args_json(json!({"car_id": car_ids[1], "plot_id": "plot-main-n-0", "slot": 0}))
        .transact()
        .await?;
    assert!(parked.is_success(), "meter parking failed: {parked:?}");
    let parked_event = emitted(&parked, "parked")?;
    let session: Value = parked.json()?;
    assert_eq!(parked_event["session_id"], session["id"]);
    assert_eq!(session["legal"], true);
    assert_eq!(session["terms"]["meter_recipient"], owner.id().to_string());
    worker.fast_forward(400).await?;
    let meter_settlement = driver
        .call(contract.id(), "collect")
        .args_json(json!({"expected_session_id": session["id"]}))
        .transact()
        .await?;
    assert!(
        meter_settlement.is_success(),
        "meter collection failed: {meter_settlement:?}"
    );
    let collected_event = emitted(&meter_settlement, "collected")?;
    let meter_paid: Value = meter_settlement.json()?;
    assert_eq!(collected_event["gross"], meter_paid["gross"]);
    let gross = amount(&meter_paid, "gross")?;
    let fee = amount(&meter_paid, "recipient_payout")?;
    let driver_paid = amount(&meter_paid, "driver_payout")?;
    assert!(gross > 0 && fee > 0);
    assert_eq!(
        fee,
        gross / 2,
        "30-per-hour meter reaches the half-gross cap"
    );
    assert_eq!(driver_paid + fee, gross);
    assert_eq!(
        balance(&contract, &driver).await?,
        100_000_000 + driver_paid
    );
    assert_eq!(balance(&contract, &owner).await?, 100_000_000 + fee);
    let duplicate = driver
        .call(contract.id(), "collect")
        .args_json(json!({"expected_session_id": session["id"]}))
        .transact()
        .await?;
    assert!(duplicate.is_failure(), "meter collection paid twice");

    // Distinct signers submit for the same curb before either result is observed.
    let driver_park = driver
        .call(contract.id(), "park")
        .args_json(json!({"car_id": car_ids[1], "plot_id": "plot-main-n-0", "slot": 0}))
        .transact();
    let rival_park = rival
        .call(contract.id(), "park")
        .args_json(json!({"car_id": car_ids[2], "plot_id": "plot-main-n-0", "slot": 0}))
        .transact();
    let (driver_result, rival_result) = tokio::join!(driver_park, rival_park);
    let driver_result = driver_result?;
    let rival_result = rival_result?;
    assert_ne!(driver_result.is_success(), rival_result.is_success());
    let (winner, won) = if driver_result.is_success() {
        (&driver, driver_result)
    } else {
        (&rival, rival_result)
    };
    let winning_session: Value = won.json()?;
    let occupancy: Value = contract
        .call("get_space_session")
        .args_json(json!({"plot_id": "plot-main-n-0", "slot": 0}))
        .view()
        .await?
        .json()?;
    assert_eq!(occupancy["id"], winning_session["id"]);
    let release = winner
        .call(contract.id(), "collect")
        .args_json(json!({"expected_session_id": winning_session["id"]}))
        .transact()
        .await?;
    assert!(
        release.is_success(),
        "race winner could not collect: {release:?}"
    );

    let no_parking = owner
        .call(contract.id(), "set_rule")
        .args_json(json!({"plot_id": "plot-main-n-0", "rule": {"kind": "NoParking"}}))
        .transact()
        .await?;
    assert!(
        no_parking.is_success(),
        "NoParking rule failed: {no_parking:?}"
    );
    let illegal_rival = rival
        .call(contract.id(), "park")
        .args_json(json!({"car_id": car_ids[2], "plot_id": "plot-main-n-0", "slot": 0}))
        .transact()
        .await?;
    assert!(
        illegal_rival.is_success(),
        "rival parking failed: {illegal_rival:?}"
    );
    let rival_session: Value = illegal_rival.json()?;
    assert_eq!(rival_session["legal"], false);
    let illegal_driver = driver
        .call(contract.id(), "park")
        .args_json(json!({"car_id": car_ids[1], "plot_id": "plot-main-n-0", "slot": 1}))
        .transact()
        .await?;
    assert!(
        illegal_driver.is_success(),
        "driver parking failed: {illegal_driver:?}"
    );
    let driver_session: Value = illegal_driver.json()?;
    assert_eq!(driver_session["legal"], false);

    let too_new = inspector
        .call(contract.id(), "inspect")
        .args_json(json!({
            "plot_id": "plot-main-n-0", "slot": 0,
            "expected_session_id": rival_session["id"]
        }))
        .transact()
        .await?;
    assert!(too_new.is_failure(), "inspection age gate was bypassed");
    let not_attempted: Value = contract
        .call("get_session")
        .args_json(json!({"session_id": rival_session["id"]}))
        .view()
        .await?
        .json()?;
    assert_eq!(not_attempted["inspector_attempted"], false);
    worker.fast_forward(500).await?;
    let failed_roll = inspector
        .call(contract.id(), "inspect")
        .args_json(json!({
            "plot_id": "plot-main-n-0", "slot": 0,
            "expected_session_id": rival_session["id"]
        }))
        .transact()
        .await?;
    assert!(
        failed_roll.is_success(),
        "zero-chance attempt failed: {failed_roll:?}"
    );
    assert_eq!(
        emitted(&failed_roll, "inspection_attempted")?["success"],
        false
    );
    let no_settlement: Value = failed_roll.json()?;
    assert!(no_settlement.is_null());
    let attempted: Value = contract
        .call("get_session")
        .args_json(json!({"session_id": rival_session["id"]}))
        .view()
        .await?
        .json()?;
    assert_eq!(attempted["inspector_attempted"], true);
    let repeat = inspector
        .call(contract.id(), "inspect")
        .args_json(json!({
            "plot_id": "plot-main-n-0", "slot": 0,
            "expected_session_id": rival_session["id"]
        }))
        .transact()
        .await?;
    assert!(
        repeat.is_failure(),
        "same session got another inspection roll"
    );
    let patrol_limit = inspector
        .call(contract.id(), "inspect")
        .args_json(json!({
            "plot_id": "plot-main-n-0", "slot": 1,
            "expected_session_id": driver_session["id"]
        }))
        .transact()
        .await?;
    assert!(
        patrol_limit.is_failure(),
        "global patrol limit was bypassed"
    );
    let unattempted: Value = contract
        .call("get_session")
        .args_json(json!({"session_id": driver_session["id"]}))
        .view()
        .await?
        .json()?;
    assert_eq!(unattempted["inspector_attempted"], false);

    let mut next_config: Value = contract.call("get_config").view().await?.json()?;
    next_config["version"] = json!(3);
    next_config["inspector_chance_bps"] = json!(10_000);
    let changed = contract
        .call("update_config")
        .args_json(json!({"config": next_config}))
        .transact()
        .await?;
    assert!(
        changed.is_success(),
        "inspector chance update failed: {changed:?}"
    );
    worker.fast_forward(1_200).await?;
    let treasury_before: String = contract.call("get_treasury_coins").view().await?.json()?;
    let owner_before_inspection = balance(&contract, &owner).await?;
    let success = inspector
        .call(contract.id(), "inspect")
        .args_json(json!({
            "plot_id": "plot-main-n-0", "slot": 1,
            "expected_session_id": driver_session["id"]
        }))
        .transact()
        .await?;
    assert!(
        success.is_success(),
        "guaranteed inspection failed: {success:?}"
    );
    assert_eq!(emitted(&success, "inspection_attempted")?["success"], true);
    let inspector_ticket_event = emitted(&success, "ticketed")?;
    let inspected: Value = success.json()?;
    assert_eq!(inspector_ticket_event["gross"], inspected["gross"]);
    assert_eq!(amount(&inspected, "driver_payout")?, 0);
    let treasury_after: String = contract.call("get_treasury_coins").view().await?.json()?;
    assert_eq!(
        treasury_after.parse::<u128>()? - treasury_before.parse::<u128>()?,
        amount(&inspected, "recipient_payout")?
    );
    assert_eq!(balance(&contract, &owner).await?, owner_before_inspection);

    // The failed inspection leaves this illegal session for an owner ticket or driver collection.
    let owner_before_race = balance(&contract, &owner).await?;
    let rival_before_race = balance(&contract, &rival).await?;
    let ticket = owner
        .call(contract.id(), "ticket")
        .args_json(json!({
            "plot_id": "plot-main-n-0", "slot": 0,
            "expected_session_id": rival_session["id"]
        }))
        .transact();
    let collect = rival
        .call(contract.id(), "collect")
        .args_json(json!({"expected_session_id": rival_session["id"]}))
        .transact();
    let (ticket_result, collect_result) = tokio::join!(ticket, collect);
    let ticket_result = ticket_result?;
    let collect_result = collect_result?;
    assert_ne!(ticket_result.is_success(), collect_result.is_success());
    let winning_event = if ticket_result.is_success() {
        emitted(&ticket_result, "ticketed")?
    } else {
        emitted(&collect_result, "collected")?
    };
    let paid: Value = if ticket_result.is_success() {
        ticket_result.json()?
    } else {
        collect_result.json()?
    };
    assert_eq!(winning_event["gross"], paid["gross"]);
    assert_eq!(
        amount(&paid, "gross")?,
        amount(&paid, "driver_payout")?
            + amount(&paid, "recipient_payout")?
            + amount(&paid, "forfeited")?
    );
    assert_eq!(
        balance(&contract, &owner).await? - owner_before_race,
        amount(&paid, "recipient_payout")?
    );
    assert_eq!(
        balance(&contract, &rival).await? - rival_before_race,
        amount(&paid, "driver_payout")?
    );
    let released: Value = contract
        .call("get_space_session")
        .args_json(json!({"plot_id": "plot-main-n-0", "slot": 0}))
        .view()
        .await?
        .json()?;
    assert!(released.is_null(), "settlement race left the curb occupied");
    let duplicate = rival
        .call(contract.id(), "collect")
        .args_json(json!({"expected_session_id": rival_session["id"]}))
        .transact()
        .await?;
    assert!(duplicate.is_failure(), "raced session paid twice");

    let mut short_config: Value = contract.call("get_config").view().await?.json()?;
    short_config["version"] = json!(4);
    short_config["earn_cap_seconds"] = json!(60);
    short_config["expiry_grace_seconds"] = json!(0);
    let shortened = contract
        .call("update_config")
        .args_json(json!({"config": short_config}))
        .transact()
        .await?;
    assert!(
        shortened.is_success(),
        "short session update failed: {shortened:?}"
    );
    let old = driver
        .call(contract.id(), "park")
        .args_json(json!({"car_id": car_ids[1], "plot_id": "plot-main-n-0", "slot": 0}))
        .transact()
        .await?;
    assert!(old.is_success(), "expiring park failed: {old:?}");
    let old_session: Value = old.json()?;
    worker.fast_forward(400).await?;
    let driver_before_expiry = balance(&contract, &driver).await?;
    let explicit_expiry = owner
        .call(contract.id(), "settle_expired")
        .args_json(json!({"expected_session_id": old_session["id"]}))
        .transact();
    let reuse = rival
        .call(contract.id(), "park")
        .args_json(json!({"car_id": car_ids[2], "plot_id": "plot-main-n-0", "slot": 0}))
        .transact();
    let (expiry_result, reuse_result) = tokio::join!(explicit_expiry, reuse);
    let expiry_result = expiry_result?;
    let reuse_result = reuse_result?;
    assert!(
        reuse_result.is_success(),
        "expired space could not be reused: {reuse_result:?}"
    );
    assert_eq!(
        event_count(&expiry_result, "expired")? + event_count(&reuse_result, "expired")?,
        1,
        "old session emitted more than one expiry"
    );
    let expiry_event = if expiry_result.is_success() {
        emitted(&expiry_result, "expired")?
    } else {
        emitted(&reuse_result, "expired")?
    };
    let replacement_session: Value = reuse_result.json()?;
    assert_eq!(expiry_event["session_id"], old_session["id"]);
    assert_eq!(
        balance(&contract, &driver).await? - driver_before_expiry,
        amount(&expiry_event, "driver_payout")?
    );
    let old_after_race: Value = contract
        .call("get_session")
        .args_json(json!({"session_id": old_session["id"]}))
        .view()
        .await?
        .json()?;
    assert!(old_after_race.is_null(), "expired session remained live");
    let occupied: Value = contract
        .call("get_space_session")
        .args_json(json!({"plot_id": "plot-main-n-0", "slot": 0}))
        .view()
        .await?
        .json()?;
    assert_eq!(occupied["id"], replacement_session["id"]);
    let duplicate_expiry = owner
        .call(contract.id(), "settle_expired")
        .args_json(json!({"expected_session_id": old_session["id"]}))
        .transact()
        .await?;
    assert!(duplicate_expiry.is_failure(), "expired session paid twice");
    Ok(())
}
