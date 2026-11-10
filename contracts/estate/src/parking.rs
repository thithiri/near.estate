use near_sdk::{env, json_types::U128, near, AccountId};

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Facility {
    Curb,
    Tower,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct SessionTerms {
    pub config_version: u32,
    pub base_rate_per_hour: U128,
    pub tier_multiplier_bps: u16,
    pub legality_multiplier_bps: u16,
    pub facility_multiplier_bps: u16,
    pub meter_rate_per_hour: U128,
    pub earn_cap_seconds: u32,
    pub ticket_recipient_bps: u16,
    pub meter_recipient: Option<AccountId>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct ParkingSession {
    pub id: u64,
    pub car_id: u64,
    pub driver: AccountId,
    pub location_id: String,
    pub slot: u8,
    pub facility: Facility,
    pub started_at: u64,
    pub earn_until: u64,
    pub expires_at: u64,
    pub legal: bool,
    pub terms: SessionTerms,
    pub inspector_attempted: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Settlement {
    pub session_id: u64,
    pub gross: U128,
    pub driver_payout: U128,
    pub recipient_payout: U128,
    pub forfeited: U128,
}

#[derive(Clone, Copy)]
pub enum SettlementReason {
    Collect,
    Expire,
    Ticket,
}

pub fn calculate_settlement(
    session: &ParkingSession,
    now: u64,
    reason: SettlementReason,
) -> Settlement {
    let seconds = now
        .saturating_sub(session.started_at)
        .min(u64::from(session.terms.earn_cap_seconds));
    let numerator = checked_mul(
        session.terms.base_rate_per_hour.0,
        u128::from(session.terms.tier_multiplier_bps),
    );
    let numerator = checked_mul(numerator, u128::from(session.terms.legality_multiplier_bps));
    let numerator = checked_mul(numerator, u128::from(session.terms.facility_multiplier_bps));
    let numerator = checked_mul(numerator, u128::from(seconds));
    let gross = numerator / (3_600u128 * 10_000u128.pow(3));
    match reason {
        SettlementReason::Ticket => {
            let recipient =
                checked_mul(gross, u128::from(session.terms.ticket_recipient_bps)) / 10_000;
            Settlement {
                session_id: session.id,
                gross: U128(gross),
                driver_payout: U128(0),
                recipient_payout: U128(recipient),
                forfeited: U128(gross - recipient),
            }
        }
        SettlementReason::Collect | SettlementReason::Expire => {
            let meter =
                checked_mul(session.terms.meter_rate_per_hour.0, u128::from(seconds)) / 3_600;
            let recipient = meter.min(gross / 2);
            Settlement {
                session_id: session.id,
                gross: U128(gross),
                driver_payout: U128(gross - recipient),
                recipient_payout: U128(recipient),
                forfeited: U128(0),
            }
        }
    }
}

fn checked_mul(a: u128, b: u128) -> u128 {
    a.checked_mul(b)
        .unwrap_or_else(|| env::panic_str("parking reward overflow"))
}
