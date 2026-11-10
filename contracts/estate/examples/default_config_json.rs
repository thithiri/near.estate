use near_estate_contract::GameConfig;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!(
        "{}",
        near_sdk::serde_json::to_string(&GameConfig::default())?
    );
    Ok(())
}
