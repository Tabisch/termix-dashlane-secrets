import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { KeyRound, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useTranslation, type TabProps } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  Checkbox,
  EmptyState,
  ListBadge,
  ListRow,
  PanelList,
  PanelShell,
  SectionCard,
  SecretField,
  StatRow,
  SwitchRow,
  useConfirm,
} from "@termix-ssh/plugin-sdk/ui";
import { errorMessage, type DashlaneApi, type Status } from "./api";

type Connected = Extract<Status, { connected: true }>;

function ConnectForm({
  api,
  onConnected,
}: {
  api: DashlaneApi;
  onConnected: (status: Status) => void;
}) {
  const { t } = useTranslation();
  const [deviceKey, setDeviceKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!deviceKey.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      onConnected(await api.connect(deviceKey.trim()));
      setDeviceKey("");
    } catch (e) {
      setError(errorMessage(e, t("error.generic")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard
      title={t("connect.title")}
      icon={<KeyRound className="size-4" />}
    >
      <form onSubmit={submit} className="flex flex-col gap-3 text-xs">
        <p className="text-muted-foreground">{t("connect.intro")}</p>
        <code className="border border-border bg-muted px-2 py-1 font-mono">
          {t("connect.command")}
        </code>
        <SecretField
          label={t("connect.keyLabel")}
          value={deviceKey}
          onChange={setDeviceKey}
          placeholder={t("connect.keyPlaceholder")}
          hint={t("connect.keyHint")}
          error={error}
          disabled={busy}
        />
        <div>
          <Button type="submit" size="sm" disabled={busy || !deviceKey.trim()}>
            {busy ? t("connect.connecting") : t("connect.submit")}
          </Button>
        </div>
      </form>
    </SectionCard>
  );
}

function ConnectedView({
  api,
  status,
  onStatus,
}: {
  api: DashlaneApi;
  status: Connected;
  onStatus: (status: Status) => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [chosen, setChosen] = useState<string[]>(status.collections);
  const [removeMissing, setRemoveMissing] = useState(status.removeMissing);
  const [busy, setBusy] = useState<
    null | "save" | "sync" | "refresh" | "disconnect"
  >(null);

  useEffect(() => {
    setChosen(status.collections);
    setRemoveMissing(status.removeMissing);
  }, [status.collections, status.removeMissing]);

  const dirty =
    removeMissing !== status.removeMissing ||
    chosen.length !== status.collections.length ||
    chosen.some((name, index) => name !== status.collections[index]);

  // Chosen collections that are gone from the vault still show, so they can be unticked.
  const rows = useMemo(() => {
    const available = status.availableCollections.map((c) => ({
      ...c,
      missing: false,
    }));
    const known = new Set(available.map((c) => c.name.toLowerCase()));
    for (const name of status.collections) {
      if (!known.has(name.toLowerCase())) {
        available.push({ name, items: 0, missing: true });
      }
    }
    return available;
  }, [status.availableCollections, status.collections]);

  const run = async (
    kind: NonNullable<typeof busy>,
    action: () => Promise<Status>,
    success?: string,
  ) => {
    setBusy(kind);
    try {
      onStatus(await action());
      if (success) toast.success(success);
    } catch (e) {
      toast.error(errorMessage(e, t("error.generic")));
      // A failed sync still recorded why, so show it.
      if (kind === "sync") onStatus(await api.status().catch(() => status));
    } finally {
      setBusy(null);
    }
  };

  const toggle = (name: string, on: boolean) =>
    setChosen((previous) =>
      on ? [...previous, name] : previous.filter((entry) => entry !== name),
    );

  const disconnect = async () => {
    const ok = await confirm({
      title: t("account.disconnectTitle"),
      description: t("account.disconnectBody"),
      confirmLabel: t("account.disconnectKeep"),
    });
    if (!ok) return;
    await run(
      "disconnect",
      () => api.disconnect(false),
      t("account.disconnected"),
    );
  };

  const disconnectAndRemove = async () => {
    const ok = await confirm({
      title: t("account.disconnectTitle"),
      description: t("account.disconnectBody"),
      confirmLabel: t("account.disconnectRemove"),
    });
    if (!ok) return;
    await run(
      "disconnect",
      () => api.disconnect(true),
      t("account.disconnected"),
    );
  };

  const summary = status.lastSummary;

  return (
    <div className="flex flex-col gap-2">
      <SectionCard
        title={t("account.title")}
        icon={<KeyRound className="size-4" />}
        action={
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={disconnect}
              disabled={busy !== null}
            >
              {t("account.disconnect")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              onClick={disconnectAndRemove}
              disabled={busy !== null}
            >
              {t("account.disconnectRemove")}
            </Button>
          </div>
        }
      >
        <StatRow label={t("account.login")} value={status.login} mono />
      </SectionCard>

      <SectionCard
        title={t("collections.title")}
        icon={<KeyRound className="size-4" />}
        action={
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => run("refresh", api.refreshCollections)}
          >
            <RefreshCw className="size-3.5" />
            {t("collections.refresh")}
          </Button>
        }
      >
        <div className="flex flex-col gap-2 text-xs">
          <p className="text-muted-foreground">{t("collections.hint")}</p>
          {rows.length === 0 ? (
            <EmptyState title={t("collections.empty")} />
          ) : (
            <div className="flex flex-col">
              {rows.map((row) => {
                const id = `dashlane-collection-${row.name}`;
                return (
                  <label
                    key={row.name}
                    htmlFor={id}
                    className="flex items-center gap-2 border-b border-border py-1.5 last:border-b-0"
                  >
                    <Checkbox
                      id={id}
                      checked={chosen.includes(row.name)}
                      onCheckedChange={(value) =>
                        toggle(row.name, value === true)
                      }
                    />
                    <span className="flex-1">{row.name}</span>
                    {row.missing ? (
                      <ListBadge tone="warning">
                        {t("collections.missing")}
                      </ListBadge>
                    ) : (
                      <span className="text-muted-foreground">
                        {t("collections.items", { count: row.items })}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          )}
          <SwitchRow
            label={t("collections.removeMissing")}
            description={t("collections.removeMissingHint")}
            checked={removeMissing}
            onChange={setRemoveMissing}
          />
          <div>
            <Button
              size="sm"
              disabled={!dirty || busy !== null}
              onClick={() =>
                run(
                  "save",
                  () => api.saveConfig(chosen, removeMissing),
                  t("collections.saved"),
                )
              }
            >
              {t("collections.save")}
            </Button>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title={t("sync.title")}
        icon={<RefreshCw className="size-4" />}
        action={
          <Button
            size="sm"
            disabled={busy !== null || dirty || status.collections.length === 0}
            onClick={() => run("sync", api.sync, t("sync.ok"))}
          >
            {busy === "sync" ? t("sync.running") : t("sync.now")}
          </Button>
        }
      >
        <div className="flex flex-col gap-1 text-xs">
          <StatRow
            label={t("sync.last")}
            value={
              status.lastSyncAt
                ? new Date(status.lastSyncAt).toLocaleString()
                : t("sync.never")
            }
          />
          {status.lastStatus === "error" && (
            <p className="text-destructive">
              {t("sync.failed")}: {status.lastError}
            </p>
          )}
          {status.lastStatus === "ok" && summary && (
            <p className="text-muted-foreground">
              {t("sync.summary", { ...summary })}
              {summary.skipped > 0 && ` ${t("sync.skippedHint")}`}
            </p>
          )}
          <p className="text-muted-foreground">
            {status.syncIntervalMinutes > 0
              ? t("sync.interval", { count: status.syncIntervalMinutes })
              : t("sync.manualOnly")}
          </p>
        </div>
      </SectionCard>

      <SectionCard
        title={t("imported.title")}
        icon={<KeyRound className="size-4" />}
      >
        <PanelList empty={<EmptyState title={t("imported.empty")} />}>
          {status.items.map((item) => (
            <ListRow
              key={item.credentialId}
              title={item.title ?? String(item.credentialId)}
              meta={item.collection}
            />
          ))}
        </PanelList>
      </SectionCard>
    </div>
  );
}

export function DashlaneTab({
  isVisible,
  api,
}: TabProps & { api: DashlaneApi }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api.status());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [api]);

  useEffect(() => {
    if (isVisible) void load();
  }, [isVisible, load]);

  return (
    <PanelShell
      icon={<KeyRound className="size-4" />}
      title={t("tab.title")}
      scroll
    >
      <div className="p-2.5">
        {failed && <EmptyState title={t("error.load")} />}
        {!failed && status && !status.connected && (
          <ConnectForm api={api} onConnected={setStatus} />
        )}
        {!failed && status?.connected && (
          <ConnectedView api={api} status={status} onStatus={setStatus} />
        )}
      </div>
    </PanelShell>
  );
}
