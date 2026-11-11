use anyhow::{bail, ensure, Context, Result};
use near_sdk::serde_json;
use near_workspaces::Account;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RoleRecord {
    account_id: String,
    key_file: String,
}

fn private_directory() -> Result<PathBuf> {
    let raw = std::env::var("ESTATE_DEV_KEY_DIR")
        .context("ESTATE_DEV_KEY_DIR is required and must point outside the repository")?;
    let path = PathBuf::from(raw);
    ensure!(path.is_absolute(), "ESTATE_DEV_KEY_DIR must be absolute");
    std::fs::create_dir_all(&path)?;
    let path = path.canonicalize()?;
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?;
    ensure!(
        !path.starts_with(root),
        "testnet credentials must stay outside the repository"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(path)
}

async fn account_for_role(
    worker: &near_workspaces::Worker<near_workspaces::network::Testnet>,
    directory: &Path,
    role: &str,
) -> Result<Account> {
    let record_path = directory.join(format!("{role}.json"));
    if record_path.exists() {
        let record: RoleRecord = serde_json::from_slice(&std::fs::read(&record_path)?)?;
        let key_file = PathBuf::from(&record.key_file);
        ensure!(
            key_file.parent() == Some(directory),
            "stored {role} key path is outside the private directory"
        );
        let account = Account::from_file(&key_file, worker)?;
        ensure!(
            account.id().as_str() == record.account_id,
            "stored {role} key belongs to another account"
        );
        worker
            .view_account(account.id())
            .await
            .with_context(|| format!("stored {role} account is unavailable"))?;
        return Ok(account);
    }
    let account = worker.dev_create_account().await?;
    account.store_credentials(directory).await?;
    let key_file = directory.join(format!("{}.json", account.id()));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&key_file, std::fs::Permissions::from_mode(0o600))?;
    }
    let record = RoleRecord {
        account_id: account.id().to_string(),
        key_file: key_file.display().to_string(),
    };
    std::fs::write(&record_path, serde_json::to_vec_pretty(&record)?)?;
    println!("Created {role} testnet account: {}", account.id());
    Ok(account)
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let roles: Vec<&str> = match args.as_slice() {
        [apply] if apply == "--apply" => {
            vec!["contract", "moderator", "inspector", "driver", "owner"]
        }
        [apply, role_flag, role] if apply == "--apply" && role_flag == "--role" => {
            match role.as_str() {
                "contract" => vec!["contract"],
                "moderator" => vec!["moderator"],
                "inspector" => vec!["inspector"],
                "driver" => vec!["driver"],
                "owner" => vec!["owner"],
                _ => bail!("unknown testnet role: {role}"),
            }
        }
        _ => bail!("pass --apply [--role contract|moderator|inspector|driver|owner]"),
    };
    let directory = private_directory()?;
    let rpc_url = std::env::var("ESTATE_TESTNET_RPC_URL")
        .unwrap_or_else(|_| "https://test.rpc.fastnear.com".to_string());
    ensure!(
        rpc_url.starts_with("https://"),
        "testnet RPC must use HTTPS"
    );
    let worker = near_workspaces::testnet().rpc_addr(&rpc_url).await?;
    ensure!(
        worker.status().await?.chain_id == "testnet",
        "RPC is not testnet"
    );
    for role in roles {
        let account = account_for_role(&worker, &directory, role).await?;
        println!("{role}: {}", account.id());
    }
    println!("Credential files are private in {}", directory.display());
    Ok(())
}
