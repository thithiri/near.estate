use anyhow::{bail, ensure, Context, Result};
use near_sdk::serde_json::{json, Value};
use near_workspaces::{
    types::{AccessKey, AccessKeyPermission, AccountId, KeyType, NearToken, SecretKey},
    Account, Worker,
};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

const ALLOWANCE_YOCTO: u128 = 250_000_000_000_000_000_000_000;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn private_path(name: &str, must_exist: bool) -> Result<PathBuf> {
    let path = PathBuf::from(std::env::var(name).with_context(|| format!("Set {name}"))?);
    ensure!(path.is_absolute(), "{name} must be absolute");
    let parent = path
        .parent()
        .context("key path has no parent")?
        .canonicalize()?;
    ensure!(
        !parent.starts_with(root().canonicalize()?),
        "key files must stay outside the repository"
    );
    if must_exist {
        ensure!(path.is_file(), "{name} does not exist");
    }
    Ok(path)
}

fn read_runtime_secret(path: &Path, account_id: &AccountId) -> Result<Option<SecretKey>> {
    if !path.exists() {
        return Ok(None);
    }
    ensure!(
        !std::fs::symlink_metadata(path)?.file_type().is_symlink(),
        "runtime key file must not be a symlink"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            std::fs::metadata(path)?.permissions().mode() & 0o077 == 0,
            "runtime key file is readable by another user"
        );
    }
    let record: Value = near_sdk::serde_json::from_slice(&std::fs::read(path)?)?;
    ensure!(
        record["account_id"] == account_id.as_str(),
        "runtime key belongs to another account"
    );
    Ok(Some(
        record["private_key"]
            .as_str()
            .context("runtime key lacks private_key")?
            .parse()?,
    ))
}

fn write_runtime_secret(path: &Path, account_id: &AccountId, secret: &SecretKey) -> Result<()> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let bytes = near_sdk::serde_json::to_vec_pretty(&json!({
        "account_id": account_id,
        "private_key": secret.to_string(),
    }))?;
    options.open(path)?.write_all(&bytes)?;
    Ok(())
}

async fn verify_scope(
    inspector: &Account,
    contract_id: &AccountId,
    public_key: &near_workspaces::types::PublicKey,
) -> Result<u128> {
    let access = inspector.view_access_key(public_key).await?;
    let AccessKeyPermission::FunctionCall(permission) = access.permission else {
        bail!("runtime key must have function-call permission");
    };
    ensure!(
        permission.receiver_id == contract_id.as_str() && permission.method_names == ["inspect"],
        "runtime key permissions do not match inspect-only policy"
    );
    Ok(permission
        .allowance
        .context("runtime key needs a finite allowance")?
        .as_yoctonear())
}

async fn verify_permission(
    inspector: &Account,
    contract_id: &AccountId,
    public_key: &near_workspaces::types::PublicKey,
) -> Result<()> {
    let allowance = verify_scope(inspector, contract_id, public_key).await?;
    ensure!(allowance > 0, "runtime key allowance is exhausted");
    ensure!(
        allowance <= ALLOWANCE_YOCTO,
        "runtime key allowance exceeds the configured limit"
    );
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let mode = std::env::args()
        .nth(1)
        .context("Use --plan, --apply or --revoke")?;
    ensure!(
        ["--plan", "--apply", "--revoke"].contains(&mode.as_str()),
        "Use --plan, --apply or --revoke"
    );
    let contract_id: AccountId = std::env::var("ESTATE_CONTRACT_ID")
        .context("Set ESTATE_CONTRACT_ID")?
        .parse()?;
    ensure!(contract_id.as_str().ends_with(".testnet"), "testnet only");
    let admin_path = private_path("ESTATE_INSPECTOR_ADMIN_KEY_FILE", true)?;
    let runtime_path = private_path("ESTATE_INSPECTOR_RUNTIME_KEY_FILE", false)?;
    ensure!(
        admin_path != runtime_path,
        "admin and runtime key paths must differ"
    );
    let rpc_url = std::env::var("ESTATE_TESTNET_RPC_URL")
        .unwrap_or_else(|_| "https://test.rpc.fastnear.com".to_string());
    ensure!(rpc_url.starts_with("https://"), "testnet RPC needs HTTPS");
    let worker: Worker<near_workspaces::network::Testnet> =
        near_workspaces::testnet().rpc_addr(&rpc_url).await?;
    ensure!(
        worker.status().await?.chain_id == "testnet",
        "RPC is not testnet"
    );
    let inspector = Account::from_file(&admin_path, &worker)?;
    let roles: (AccountId, AccountId, AccountId) =
        inspector.view(&contract_id, "get_roles").await?.json()?;
    ensure!(
        roles.2 == *inspector.id(),
        "account is not the contract inspector"
    );
    let existing = read_runtime_secret(&runtime_path, inspector.id())?;
    if mode == "--plan" {
        let present = if let Some(secret) = &existing {
            inspector
                .view_access_keys()
                .await?
                .iter()
                .any(|entry| entry.public_key == secret.public_key())
        } else {
            false
        };
        if present {
            verify_permission(
                &inspector,
                &contract_id,
                &existing
                    .as_ref()
                    .context("runtime key disappeared")?
                    .public_key(),
            )
            .await?;
        }
        println!(
            "{}",
            json!({
                "contractId": contract_id,
                "inspectorId": inspector.id(),
                "runtimeFilePresent": existing.is_some(),
                "runtimeKeyOnChain": present,
            })
        );
        return Ok(());
    }
    if mode == "--revoke" {
        let secret = existing.context("runtime key file is missing")?;
        let public_key = secret.public_key();
        let present = inspector
            .view_access_keys()
            .await?
            .iter()
            .any(|entry| entry.public_key == public_key);
        if present {
            verify_scope(&inspector, &contract_id, &public_key).await?;
            let revoked = inspector
                .batch(inspector.id())
                .delete_key(public_key.clone())
                .transact()
                .await?;
            ensure!(revoked.is_success(), "inspector key revocation failed");
        }
        ensure!(
            !inspector
                .view_access_keys()
                .await?
                .iter()
                .any(|entry| entry.public_key == public_key),
            "inspector key remains on-chain"
        );
        std::fs::remove_file(&runtime_path)?;
        println!("{}", json!({"revoked": true, "publicKey": public_key}));
        return Ok(());
    }
    let secret = if let Some(secret) = existing {
        secret
    } else {
        let secret = SecretKey::from_random(KeyType::ED25519);
        write_runtime_secret(&runtime_path, inspector.id(), &secret)?;
        secret
    };
    let public_key = secret.public_key();
    let present = inspector
        .view_access_keys()
        .await?
        .iter()
        .any(|entry| entry.public_key == public_key);
    if !present {
        let added = inspector
            .batch(inspector.id())
            .add_key(
                public_key.clone(),
                AccessKey::function_call_access(
                    &contract_id,
                    &["inspect"],
                    Some(NearToken::from_yoctonear(ALLOWANCE_YOCTO)),
                ),
            )
            .transact()
            .await?;
        ensure!(added.is_success(), "inspect-only key creation failed");
    }
    verify_permission(&inspector, &contract_id, &public_key).await?;
    println!(
        "{}",
        json!({
            "contractId": contract_id,
            "inspectorId": inspector.id(),
            "publicKey": public_key,
            "allowanceYocto": ALLOWANCE_YOCTO.to_string(),
            "created": !present,
        })
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn runtime_key_file_is_private_and_account_bound() -> Result<()> {
        let suffix = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let path = std::env::temp_dir().join(format!(
            "estate-inspector-runtime-test-{}-{suffix}.json",
            std::process::id()
        ));
        let account_id: AccountId = "inspector.testnet".parse()?;
        let secret = SecretKey::from_random(KeyType::ED25519);
        write_runtime_secret(&path, &account_id, &secret)?;
        let loaded = read_runtime_secret(&path, &account_id)?.context("key file missing")?;
        assert_eq!(loaded.public_key(), secret.public_key());
        assert!(write_runtime_secret(&path, &account_id, &secret).is_err());
        let other: AccountId = "other.testnet".parse()?;
        assert!(read_runtime_secret(&path, &other).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path)?.permissions().mode() & 0o077, 0);
        }
        std::fs::remove_file(path)?;
        Ok(())
    }
}
