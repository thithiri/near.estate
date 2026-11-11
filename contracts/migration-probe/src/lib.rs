#[cfg(all(target_arch = "wasm32", not(near)))]
compile_error!("NEAR migration probe WASM must be built with --cfg near");

use near_sdk::{
    borsh::{BorshDeserialize, BorshSerialize},
    env,
    json_types::U128,
    near, require,
    store::LookupMap,
    AccountId, PanicOnDefault,
};

// This is the frozen root layout of the deployed V1 city. The probe deliberately
// reads map handles as opaque values; it never interprets or rewrites map entries.
#[derive(BorshDeserialize, BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
pub struct ConfigV1 {
    pub version: u32,
    pub coin_scale: u64,
    pub starter_coins: U128,
    pub base_rate_per_hour: U128,
    pub tier_multiplier_bps: [u16; 3],
    pub illegal_multiplier_bps: u16,
    pub tower_multiplier_bps: u16,
    pub earn_cap_seconds: u32,
    pub expiry_grace_seconds: u32,
    pub park_durability_cost: u8,
    pub max_durability: u8,
    pub max_cars: u8,
    pub account_storage_bytes: u32,
    pub plot_storage_bytes: u32,
    pub repair_cost_per_point: U128,
    pub buy_car_cost: U128,
    pub tier_upgrade_costs: [U128; 2],
    pub building_upgrade_costs: [U128; 3],
    pub change_building_type_cost: U128,
    pub meter_rate_max_per_hour: U128,
    pub rule_delay_seconds: u32,
    pub ticket_cooldown_seconds: u32,
    pub ticket_recipient_bps: u16,
    pub inspector_chance_bps: u16,
    pub inspector_min_age_seconds: u32,
    pub inspector_window_seconds: u32,
    pub inspector_max_attempts_per_window: u8,
    pub plot_base_price_yocto: U128,
    pub corner_price_bps: u16,
    pub tower_capacity: u8,
    pub burger_decal_cost: U128,
    pub logo_cooldown_seconds: u32,
    pub facade_cooldown_seconds: u32,
    pub emergency_repair_cooldown_seconds: u32,
}

#[derive(BorshDeserialize, BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
pub struct RootV1 {
    pub admin: AccountId,
    pub moderator: AccountId,
    pub inspector: AccountId,
    pub config: ConfigV1,
    pub paused: bool,
    pub accounts: LookupMap<AccountId, Vec<u8>>,
    pub cars: LookupMap<u64, Vec<u8>>,
    pub next_car_id: u64,
    pub plots: LookupMap<String, Vec<u8>>,
    pub plot_ids: LookupMap<u16, String>,
    pub plot_count: u16,
    pub npc_sites: LookupMap<String, Vec<u8>>,
    pub npc_site_ids: LookupMap<u8, String>,
    pub npc_site_count: u8,
    pub sessions: LookupMap<u64, Vec<u8>>,
    pub space_sessions: LookupMap<String, u64>,
    pub next_session_id: u64,
    pub treasury_coins: U128,
    pub inspector_window_until: u64,
    pub inspector_attempts_in_window: u8,
}

#[derive(BorshDeserialize, BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
pub struct RootV2 {
    pub old: RootV1,
    pub schema_version: u32,
}

#[cfg(not(feature = "reverse"))]
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    inner: RootV2,
}

#[cfg(not(feature = "reverse"))]
#[near]
impl Contract {
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "only the contract account can migrate"
        );
        let old: RootV1 =
            env::state_read().unwrap_or_else(|| env::panic_str("V1 state is missing"));
        require!(
            old.admin == env::current_account_id(),
            "V1 admin differs from contract"
        );
        Self {
            inner: RootV2 {
                old,
                schema_version: 2,
            },
        }
    }

    pub fn get_schema_version(&self) -> u32 {
        self.inner.schema_version
    }

    pub fn get_root_snapshot(
        &self,
    ) -> (
        AccountId,
        AccountId,
        AccountId,
        u32,
        u16,
        u8,
        u64,
        u64,
        U128,
    ) {
        let old = &self.inner.old;
        (
            old.admin.clone(),
            old.moderator.clone(),
            old.inspector.clone(),
            old.config.version,
            old.plot_count,
            old.npc_site_count,
            old.next_car_id,
            old.next_session_id,
            old.treasury_coins,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::{test_utils::VMContextBuilder, testing_env};

    #[test]
    fn frozen_v1_root_round_trips_and_v2_only_appends_a_marker() {
        let contract_id: AccountId = "city.testnet".parse().expect("contract ID");
        let moderator: AccountId = "moderator.testnet".parse().expect("moderator ID");
        let inspector: AccountId = "inspector.testnet".parse().expect("inspector ID");
        testing_env!(VMContextBuilder::new()
            .current_account_id(contract_id.clone())
            .predecessor_account_id(contract_id.clone())
            .build());
        let deployed_shape = near_estate_contract::Contract::new(
            contract_id.clone(),
            moderator.clone(),
            inspector.clone(),
        );
        let old_bytes = near_sdk::borsh::to_vec(&deployed_shape).expect("V1 root bytes");
        let old: RootV1 = near_sdk::borsh::from_slice(&old_bytes).expect("V1 parse");
        assert_eq!(old.admin, contract_id);
        assert_eq!(old.moderator, moderator);
        assert_eq!(old.inspector, inspector);
        assert_eq!(old.config.version, 1);
        assert_eq!(
            near_sdk::borsh::to_vec(&old).expect("V1 round trip"),
            old_bytes
        );
        let new = RootV2 {
            old,
            schema_version: 2,
        };
        let mut expected = old_bytes;
        expected.extend_from_slice(&2u32.to_le_bytes());
        assert_eq!(near_sdk::borsh::to_vec(&new).expect("V2 root"), expected);
        let reparsed: RootV2 = near_sdk::borsh::from_slice(&expected).expect("V2 parse");
        assert_eq!(reparsed.schema_version, 2);
    }
}

#[cfg(feature = "reverse")]
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    inner: RootV1,
}

#[cfg(feature = "reverse")]
#[near]
impl Contract {
    #[init(ignore_state)]
    pub fn reverse() -> Self {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "only the contract account can reverse migration"
        );
        let new: RootV2 =
            env::state_read().unwrap_or_else(|| env::panic_str("V2 state is missing"));
        require!(new.schema_version == 2, "unexpected schema version");
        require!(
            new.old.admin == env::current_account_id(),
            "V1 admin differs from contract"
        );
        Self { inner: new.old }
    }
}
