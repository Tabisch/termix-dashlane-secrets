import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

const connected = {
  connected: true,
  syncIntervalMinutes: 60,
  login: "someone@example.com",
  collections: ["Servers"],
  availableCollections: [
    { name: "Personal", items: 1 },
    { name: "Servers", items: 2 },
  ],
  removeMissing: true,
  lastSyncAt: "2026-10-18T10:00:00.000Z",
  lastStatus: "ok",
  lastError: null,
  lastSummary: { created: 2, updated: 0, unchanged: 0, removed: 0, skipped: 1 },
  items: [
    { title: "web-1", collection: "Servers", credentialId: 7, updatedAt: "" },
  ],
};

describe(`${manifest.id} activate`, () => {
  it("registers the rail item and tab", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.tabs()).toEqual(["dashlane"]);
    expect(rendered.registered.railItems()).toEqual([
      expect.objectContaining({
        id: "dashlane",
        permission: "dashlane-secrets.use",
      }),
    ]);
  });

  it("asks for a device key when not connected, and sends it", async () => {
    const post = vi.fn(async () => ({ data: connected }));
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: {
        get: vi.fn(async () => ({
          data: { connected: false, syncIntervalMinutes: 60 },
        })),
        post,
      } as never,
    });
    rendered.renderTab("dashlane", { isVisible: true });
    await screen.findByText(locales.connect.title);
    fireEvent.change(
      screen.getByPlaceholderText(locales.connect.keyPlaceholder),
      {
        target: { value: "dls_abc_def" },
      },
    );
    fireEvent.click(screen.getByText(locales.connect.submit));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/connect", {
        deviceKey: "dls_abc_def",
      }),
    );
    expect(await screen.findByText("someone@example.com")).toBeTruthy();
  });

  it("shows the server's reason when connecting fails", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: {
        get: vi.fn(async () => ({
          data: { connected: false, syncIntervalMinutes: 60 },
        })),
        post: vi.fn(async () => {
          throw { response: { data: { error: "Device deactivated" } } };
        }),
      } as never,
    });
    rendered.renderTab("dashlane", { isVisible: true });
    fireEvent.change(
      await screen.findByPlaceholderText(locales.connect.keyPlaceholder),
      {
        target: { value: "dls_abc_def" },
      },
    );
    fireEvent.click(screen.getByText(locales.connect.submit));
    expect(await screen.findByText("Device deactivated")).toBeTruthy();
  });

  it("shows collections, the last sync and what was imported", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: { get: vi.fn(async () => ({ data: connected })) } as never,
    });
    rendered.renderTab("dashlane", { isVisible: true });
    expect(await screen.findByText("Personal")).toBeTruthy();
    expect(screen.getByText("2 logins")).toBeTruthy();
    expect(screen.getByText("web-1")).toBeTruthy();
    expect(
      screen.getByText(/2 added, 0 updated, 0 unchanged, 0 removed, 1 skipped/),
    ).toBeTruthy();
    expect(screen.getByText("Syncs every 60 minutes.")).toBeTruthy();
  });

  it("saves the chosen collections", async () => {
    const put = vi.fn(async () => ({
      data: { ...connected, collections: ["Servers", "Personal"] },
    }));
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: { get: vi.fn(async () => ({ data: connected })), put } as never,
    });
    rendered.renderTab("dashlane", { isVisible: true });
    fireEvent.click(await screen.findByText("Personal"));
    fireEvent.click(screen.getByText(locales.collections.save));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("/config", {
        collections: ["Servers", "Personal"],
        removeMissing: true,
      }),
    );
  });

  it("runs a sync", async () => {
    const post = vi.fn(async () => ({ data: connected }));
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: { get: vi.fn(async () => ({ data: connected })), post } as never,
    });
    rendered.renderTab("dashlane", { isVisible: true });
    fireEvent.click(await screen.findByText(locales.sync.now));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/sync"));
  });

  it("flags a chosen collection that is gone from the vault", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: {
        get: vi.fn(async () => ({
          data: { ...connected, collections: ["Servers", "Old"] },
        })),
      } as never,
    });
    rendered.renderTab("dashlane", { isVisible: true });
    expect(await screen.findByText("Old")).toBeTruthy();
    expect(screen.getByText(locales.collections.missing)).toBeTruthy();
  });
});
