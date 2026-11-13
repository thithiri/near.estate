use super::*;
use crate::runtime::TicketRewardPolicy;
use near_estate_contract::{
    BuildingType, CarBody, CarColor, MediaIdentity, MediaKind, ParkingRule, PendingRule, Settlement,
};
use near_sdk::{test_utils::VMContextBuilder, testing_env};
use std::panic::{catch_unwind, AssertUnwindSafe};

const PLOT_ID: &str = "plot-main-n-1";
const COIN: u128 = 1_000_000;

fn account(name: &str) -> AccountId {
    name.parse().expect("test account ID")
}

fn context(caller: &str, seconds: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(account("city.testnet"))
        .predecessor_account_id(account(caller))
        .block_timestamp(seconds * 1_000_000_000)
        .build());
}

fn fixture(rule: ParkingRule) -> Contract {
    context("city.testnet", 1_000);
    let owner = account("owner.testnet");
    let driver = account("driver.testnet");
    let seed = PlotSeedV2 {
        road_id: RoadId::Main,
        side: Side::North,
        index: 1,
        frontage_units: 3,
        building_type: BuildingType::Retail,
        variant: 1,
    };
    let mut plot = PlotV2::unowned(&seed);
    assert_eq!(plot.id, PLOT_ID);
    plot.owner = Some(owner.clone());
    plot.rule = rule;
    plot.reserved_storage_bytes = 4_096;

    let mut root = CityRootV2 {
        admin: account("city.testnet"),
        moderator: account("moderator.testnet"),
        inspector: account("inspector.testnet"),
        config: GameConfigV2::from_legacy(GameConfig::default()),
        paused: false,
        accounts: LookupMap::new(&b"ra"[..]),
        cars: LookupMap::new(&b"rc"[..]),
        next_car_id: 2,
        plots: LookupMap::new(&b"rp"[..]),
        plot_ids: LookupMap::new(&b"ri"[..]),
        plot_count: 1,
        npc_sites: LookupMap::new(&b"rn"[..]),
        npc_site_ids: LookupMap::new(&b"rj"[..]),
        npc_site_count: 0,
        sessions: LookupMap::new(&b"rs"[..]),
        space_sessions: LookupMap::new(&b"ro"[..]),
        next_session_id: 1,
        treasury_coins: U128(0),
        inspector_window_until: 0,
        inspector_attempts_in_window: 0,
        city_version: 2,
        legacy_plots: LookupMap::new(&b"rlp"[..]),
        legacy_plot_ids: LookupMap::new(&b"rli"[..]),
        deed_moves: Vec::new(),
        source_plot_hash: String::new(),
        target_seed_hash: String::new(),
        source_root_hash: String::new(),
        initial_target_plot_hash: String::new(),
    };
    root.plots.insert(PLOT_ID.to_owned(), plot);
    root.plot_ids.insert(0, PLOT_ID.to_owned());
    for (id, car_ids) in [(owner.clone(), Vec::new()), (driver.clone(), vec![1])] {
        root.accounts.insert(
            id,
            AccountState {
                balance: U128(100 * COIN),
                car_ids,
                starter_car_id: 1,
                active_session_id: None,
                last_emergency_repair_at: None,
                burger_decal: false,
                reserved_storage_bytes: 4_096,
                used_storage_bytes: 0,
            },
        );
    }
    root.cars.insert(
        1,
        Car {
            id: 1,
            owner: driver,
            body: CarBody::Hatchback,
            color: CarColor::Red,
            tier: 1,
            durability: 100,
            parked_session_id: None,
        },
    );
    root.plots.flush();
    root.plot_ids.flush();
    root.accounts.flush();
    root.cars.flush();
    Contract { inner: root }
}

#[test]
fn third_curb_space_is_visible_and_collects_only_to_the_cap() {
    let mut contract = fixture(ParkingRule::Free);
    context("driver.testnet", 1_000);
    let session = contract.park(1, PLOT_ID.to_owned(), 2);
    assert!(session.legal);
    let street = contract.get_street_side(RoadId::Main, Side::North);
    assert_eq!(street.plots.len(), 1);
    assert_eq!(street.plots[0].slots.len(), 3);
    assert_eq!(
        street.plots[0].slots[2].as_ref().map(|s| s.id),
        Some(session.id)
    );
    assert_eq!(
        street.plots[0].car_appearances[2].as_ref().map(|c| c.id),
        Some(1)
    );
    assert_eq!(contract.get_car(1).expect("car").durability, 98);

    context("driver.testnet", 2_810);
    let payout = contract.collect(session.id);
    assert_eq!(payout.gross.0, 30 * COIN);
    assert_eq!(payout.driver_payout.0, 30 * COIN);
    assert!(contract.get_space_session(PLOT_ID.to_owned(), 2).is_none());
    assert_eq!(
        contract
            .get_account(account("driver.testnet"))
            .expect("driver")
            .balance
            .0,
        130 * COIN
    );
}

#[test]
fn meter_terms_survive_a_later_rule_change() {
    let mut contract = fixture(ParkingRule::Meter {
        rate_per_hour: U128(20 * COIN),
    });
    context("driver.testnet", 1_000);
    let session = contract.park(1, PLOT_ID.to_owned(), 0);
    let mut plot = contract
        .inner
        .plots
        .get(&PLOT_ID.to_owned())
        .expect("plot")
        .clone();
    plot.pending_rule = Some(PendingRule {
        rule: ParkingRule::NoParking,
        effective_at: 1_001,
    });
    contract.inner.plots.insert(PLOT_ID.to_owned(), plot);
    contract.inner.plots.flush();

    context("driver.testnet", 1_600);
    let payout = contract.collect(session.id);
    assert_eq!(payout.gross.0, 10 * COIN);
    assert_eq!(payout.recipient_payout.0, 3_333_333);
    assert_eq!(payout.driver_payout.0, 6_666_667);
    assert_eq!(
        contract
            .get_account(account("owner.testnet"))
            .expect("owner")
            .balance
            .0,
        100 * COIN + 3_333_333
    );
}

#[test]
fn illegal_three_unit_space_tickets_to_owner_and_frees_car() {
    let mut contract = fixture(ParkingRule::NoParking);
    context("driver.testnet", 1_000);
    let session = contract.park(1, PLOT_ID.to_owned(), 2);
    assert!(!session.legal);

    context("owner.testnet", 1_600);
    let payout = contract.ticket(PLOT_ID.to_owned(), 2, session.id);
    assert_eq!(payout.driver_payout.0, 0);
    assert_eq!(payout.recipient_payout.0, 10_500_000);
    assert_eq!(payout.forfeited.0, 4_500_000);
    assert!(contract.get_space_session(PLOT_ID.to_owned(), 2).is_none());
    assert_eq!(contract.get_car(1).expect("car").parked_session_id, None);
    assert_eq!(
        contract
            .get_account(account("owner.testnet"))
            .expect("owner")
            .balance
            .0,
        100 * COIN + 10_500_000
    );
    assert!(
        contract
            .get_plot(PLOT_ID.to_owned())
            .expect("plot")
            .plot
            .ticket_cooldown_until
            > 1_600
    );
}

#[test]
fn owner_ticket_reward_is_capped_per_plot_day_without_blocking_enforcement() {
    let mut contract = fixture(ParkingRule::NoParking);
    fn ticket_at(contract: &mut Contract, park_at: u64, ticket_at: u64) -> Settlement {
        context("driver.testnet", park_at);
        let session = contract.park(1, PLOT_ID.to_owned(), 0);
        context("owner.testnet", ticket_at);
        contract.ticket(PLOT_ID.to_owned(), 0, session.id)
    }

    let first = ticket_at(&mut contract, 1_000, 1_600);
    assert_eq!(first.recipient_payout.0, 10_500_000);
    let second = ticket_at(&mut contract, 1_601, 2_201);
    assert_eq!(second.recipient_payout.0, 10_500_000);
    assert_eq!(
        contract
            .get_account(account("owner.testnet"))
            .expect("owner")
            .balance
            .0,
        115 * COIN
    );
    assert_eq!(contract.get_treasury_coins().0, 6 * COIN);
    let status = contract.get_ticket_reward_status(PLOT_ID.to_owned());
    assert_eq!(status.owner_paid_today.0, 15 * COIN);
    assert_eq!(status.owner_remaining_today.0, 0);

    let third = ticket_at(&mut contract, 2_202, 2_802);
    assert_eq!(third.recipient_payout.0, 10_500_000);
    assert_eq!(
        contract
            .get_account(account("owner.testnet"))
            .expect("owner")
            .balance
            .0,
        115 * COIN
    );
    assert_eq!(contract.get_treasury_coins().0, 16_500_000);
    assert!(contract.get_space_session(PLOT_ID.to_owned(), 0).is_none());

    let next_day = ticket_at(&mut contract, 87_400, 88_000);
    assert_eq!(next_day.recipient_payout.0, 10_500_000);
    assert_eq!(
        contract
            .get_account(account("owner.testnet"))
            .expect("owner")
            .balance
            .0,
        125_500_000
    );
    assert_eq!(
        contract
            .get_ticket_reward_status(PLOT_ID.to_owned())
            .owner_paid_today
            .0,
        10_500_000
    );
}

#[test]
fn only_admin_can_change_ticket_reward_policy_and_zero_sends_rewards_to_treasury() {
    let mut contract = fixture(ParkingRule::NoParking);
    context("owner.testnet", 1_000);
    assert!(
        catch_unwind(AssertUnwindSafe(|| contract.set_ticket_reward_policy(
            TicketRewardPolicy {
                daily_owner_cap: U128(0),
            },
        )))
        .is_err()
    );
    context("city.testnet", 1_000);
    contract.set_ticket_reward_policy(TicketRewardPolicy {
        daily_owner_cap: U128(0),
    });
    context("driver.testnet", 1_001);
    let session = contract.park(1, PLOT_ID.to_owned(), 0);
    context("owner.testnet", 1_601);
    let settlement = contract.ticket(PLOT_ID.to_owned(), 0, session.id);
    assert_eq!(settlement.recipient_payout.0, 10_500_000);
    assert_eq!(contract.get_treasury_coins().0, 10_500_000);
    assert_eq!(
        contract
            .get_account(account("owner.testnet"))
            .expect("owner")
            .balance
            .0,
        100 * COIN
    );
}

#[test]
fn horse_course_is_an_idempotent_admin_owned_eighth_site() {
    let mut contract = fixture(ParkingRule::Free);
    contract.inner.plot_count = 100;
    contract.inner.npc_site_count = 7;
    for index in 0..7u8 {
        let id = format!("npc-old-{index}");
        contract.inner.npc_sites.insert(
            id.clone(),
            NPCSite {
                id: id.clone(),
                road_id: RoadId::Main,
                side: Side::North,
                frontage_index: 10,
                role: ServiceRole::ParkingTower,
                name: id.clone(),
                capacity: 32,
            },
        );
        contract.inner.npc_site_ids.insert(index, id);
    }
    contract.inner.npc_sites.flush();
    contract.inner.npc_site_ids.flush();
    context("owner.testnet", 1_001);
    assert!(catch_unwind(AssertUnwindSafe(|| contract.add_horse_course_site())).is_err());
    context("city.testnet", 1_002);
    let site = contract.add_horse_course_site();
    assert_eq!(site.id, "npc-harbor-horse-course");
    assert!(site.role == ServiceRole::HorseCourse);
    assert_eq!(contract.npc_site_count(), 8);
    assert_eq!(contract.add_horse_course_site().id, site.id);
    assert_eq!(contract.npc_site_count(), 8);
}

#[test]
fn moderator_can_revoke_active_facade_after_owner_submits_replacement() {
    let mut contract = fixture(ParkingRule::Free);
    context("owner.testnet", 1_000);
    let first = contract.propose_appearance(PLOT_ID.to_owned(), 1, "a".repeat(64));
    context("moderator.testnet", 1_100);
    contract.approve_appearance(PLOT_ID.to_owned(), first.clone());
    context("owner.testnet", 1_200);
    let replacement =
        contract.propose_appearance(PLOT_ID.to_owned(), first.revision, "b".repeat(64));
    context("moderator.testnet", 1_300);
    assert!(catch_unwind(AssertUnwindSafe(|| contract.revoke_appearance(
        PLOT_ID.to_owned(),
        replacement.revision + 1,
        first.manifest_hash.clone(),
        "Future revision".to_owned(),
    )))
    .is_err());
    assert!(catch_unwind(AssertUnwindSafe(|| contract.revoke_appearance(
        PLOT_ID.to_owned(),
        first.revision,
        replacement.manifest_hash.clone(),
        "Wrong active facade".to_owned(),
    )))
    .is_err());
    let revoked = contract.revoke_appearance(
        PLOT_ID.to_owned(),
        first.revision,
        first.manifest_hash,
        "Unsafe facade".to_owned(),
    );
    assert!(revoked.building.approved_manifest_hash.is_none());
    assert!(revoked.building.pending_appearance.is_none());
    assert!(revoked.building.appearance_revision > replacement.revision);
}

#[test]
fn moderator_can_revoke_active_logo_after_owner_submits_replacement() {
    let mut contract = fixture(ParkingRule::Free);
    let first_content = MediaIdentity {
        asset_hash: "a".repeat(64),
        link: None,
    };
    context("owner.testnet", 1_000);
    let first = contract.propose_media(
        PLOT_ID.to_owned(),
        MediaKind::Logo,
        0,
        1,
        first_content.clone(),
    );
    context("moderator.testnet", 1_100);
    contract.approve_media(PLOT_ID.to_owned(), MediaKind::Logo, first.clone());
    context("owner.testnet", 1_200);
    let replacement = contract.propose_media(
        PLOT_ID.to_owned(),
        MediaKind::Logo,
        first.revision,
        1,
        MediaIdentity {
            asset_hash: "b".repeat(64),
            link: None,
        },
    );
    context("moderator.testnet", 1_300);
    assert!(catch_unwind(AssertUnwindSafe(|| contract.revoke_media(
        PLOT_ID.to_owned(),
        MediaKind::Logo,
        replacement.revision + 1,
        first_content.clone(),
        "Future revision".to_owned(),
    )))
    .is_err());
    assert!(catch_unwind(AssertUnwindSafe(|| contract.revoke_media(
        PLOT_ID.to_owned(),
        MediaKind::Logo,
        first.revision,
        replacement.content.clone(),
        "Wrong active logo".to_owned(),
    )))
    .is_err());
    let revoked = contract.revoke_media(
        PLOT_ID.to_owned(),
        MediaKind::Logo,
        first.revision,
        first_content,
        "Unsafe logo".to_owned(),
    );
    assert!(!revoked.logo_eligible);
    assert!(revoked.plot.logo.active.is_none());
    assert!(revoked.plot.logo.pending.is_none());
    assert!(revoked.plot.logo.revision > replacement.revision);
}
