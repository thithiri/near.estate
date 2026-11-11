# State backup and restore

The API and event indexer share `estate.sqlite` in the `api_data` volume. The same volume holds immutable generated and uploaded PNG files under `assets/`. The deployment JSON records in `deployments/` identify the contract and release code. A backup must keep all three together; the indexer cursor is inside SQLite.

The backup contains private, unapproved artwork. Keep the backup directory readable only by the operator and copy it off the VPS through a protected channel. Moderator, inspector and deployment keys are deliberately outside this backup; preserve them separately in the protected key store or rotate them after recovery.

## Create and verify a backup

1. Stop the API, indexer and any inspector process. The SQLite backup API provides a consistent database snapshot, but the PNG files and database must be copied while no service can create, approve or remove artwork. The web server may stay online with its API temporarily unavailable.
2. Locate the `api_data` Docker volume on the host with `docker volume ls` and `docker volume inspect <volume-name>`. Use its `Mountpoint` as `<data-dir>`. Confirm it contains `estate.sqlite` and `assets/`.
3. From the release checkout, run `node scripts/state-backup.mjs backup <data-dir> <checkout>/deployments <new-backup-dir>`. Use an absolute path for a new backup directory outside the data volume. Node 22.16 or later is required for its built-in SQLite backup API.
4. Run `node scripts/state-backup.mjs verify <backup-dir>`. It checks the exact archive file list and regular directories, every file hash, content-addressed PNG name, SQLite integrity and foreign keys, the indexer cursor and event count, and the deployment contract ID. A mismatch is a failed backup.
5. Copy the verified backup to protected storage before restarting the services. Keep the original backup until a restore drill succeeds.

If Node is unavailable on the VPS host, run the same backup tool in a one-off Node 22 container after stopping the services. Mount the data volume and deployment records read-only, and mount an existing backup parent directory for output. Replace every `<...>` placeholder before running either example:

```sh
docker run --rm \
  --mount type=volume,source=<volume-name>,target=/data,readonly \
  --mount type=bind,source=<checkout>/deployments,target=/deployments,readonly \
  --mount type=bind,source=<checkout>/scripts,target=/scripts,readonly \
  --mount type=bind,source=<backup-parent>,target=/backups \
  node:22-alpine node /scripts/state-backup.mjs backup /data /deployments /backups/<backup-id>
```

The tool ignores an incomplete `.<uuid>.tmp` image write left after a crash. It rejects other unexpected files in the archive or `assets/`, an image still referenced by the database but missing on disk, missing deployment metadata, mismatched contract IDs and any backup whose final hashes differ from its manifest. Required images include pending paid candidates and approved paid candidates that an owner can still read before attaching them to a design. Node's backup API copies committed state into the archive database, but a source in WAL mode can leave WAL and shared-memory sidecars on that copy. The tool changes only the copied database to DELETE journal mode before recording its hash, so the verified archive contains one standalone SQLite file and no unlisted sidecars. [Node 22.23 SQLite backup documentation](https://nodejs.org/download/release/v22.23.0/docs/api/sqlite.html) describes the backup API.

## Restore into new storage

1. Keep all services stopped. Use new, nonexistent paths for the restored data and deployment records: `node scripts/state-backup.mjs restore <backup-dir> <new-data-dir> <new-deployments-dir>`. The command verifies the archive before copying and checks each restored hash again.
2. Open the restored database with the indexer using the same contract ID and start height from the printed cursor. Confirm the cursor and event count, then let the indexer resume from the next finalized height. Do not reset the cursor to height 1 or point this database at another contract.
3. On a VPS, create a new Docker volume and copy the contents of `<new-data-dir>` into its root, preserving file names. Set the files' owner to the `node` user used by the API and worker images. Set `ESTATE_DATA_VOLUME` to that new volume and add `-f infra/compose.volume.example.yaml` to the usual Compose command. This changes both services to the same restored volume while leaving the old volume untouched for rollback.
4. Compare `<new-deployments-dir>/testnet.json` with the live contract and the release checkout before using deployment or upgrade commands. Restore those JSON records to the checkout only when the contract ID and code hash match. Reattach or rotate protected keys separately.
5. Start the API, indexer and inspector, check `/api/health`, plot statistics freshness, asset reads and the resumed worker log. Do not delete the old volume or backup until the live checks pass.

For the volume copy in step 3, use a new volume and the already verified restore directory:

```sh
docker volume create <new-volume-name>
docker run --rm \
  --mount type=volume,source=<new-volume-name>,target=/data \
  --mount type=bind,source=<new-data-dir>,target=/source,readonly \
  node:22-alpine sh -c 'cp -a /source/. /data/ && chown -R node:node /data'
ESTATE_DATA_VOLUME=<new-volume-name> docker compose \
  -f infra/compose.yaml -f infra/compose.volume.example.yaml \
  --profile indexer config --quiet
```

## Local drill

`npm run backup:drill` creates a temporary shared API/indexer database, records a park and collection, stores immutable PNGs and an upload row, rejects backups while a required upload or approved paid-candidate image is missing, then backs up and restores the complete state. It reopens both stores, confirms replay does not duplicate an event, advances the cursor, and rejects an unexpected archive file or a tampered PNG. It cleans up the temporary files afterward. The current local result is [local-backup-drill.json](../deployments/local-backup-drill.json).

A separate restore of the disposable testnet floor-3 indexer snapshot preserved 91 finalized game events, the cursor at height 277105001, and eleven deployment JSON records. Reopening the restored indexer and rebuilding its aggregates preserved the cursor and event count. This is local recovery evidence; the target VPS volume swap, protected offsite copy and live restart remain Phase 8 work.

A further [Compose restore drill](../deployments/local-compose-restore-drill.json) copied a verified backup of the shared-city indexed snapshot into a new external Docker volume. The packaged API opened 146 events at cursor 277205914; a packaged worker resumed from the next height to 277206694 with zero new events, and the API still reported 14 curb and one tower park. The temporary services and volume were removed. This snapshot has no media PNGs, so the existing file-level image tests still provide the asset evidence; the VPS and offsite-copy steps remain open.
