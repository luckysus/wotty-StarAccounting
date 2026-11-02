"use client";

import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { APP_UPDATE_URL, CURRENT_APP_VERSION_CODE, CURRENT_APP_VERSION_NAME, hasNewerAppVersion, type AppVersionInfo } from "@/lib/stark/app-version";
import { setAppUpdateAvailable } from "@/lib/stark/app-update-status";
import { useLayeredHistoryMarker } from "@/components/stark/useLayeredHistoryMarker";

type UpdateState = { info: AppVersionInfo; unavailable: boolean } | null;
type NoticeState = { title: string; message: string } | null;
type DownloadState = {
  status: "idle" | "downloading" | "permission" | "ready" | "error";
  percent: number | null;
  downloadedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  message: string | null;
};
type NativeDownloadProgress = {
  stage: "downloading" | "permission";
  percent?: number;
  downloadedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
};
type NativeAppUpdate = {
  getInstalledVersion(): Promise<{ versionCode: number; versionName: string }>;
  downloadAndInstall(options: { url: string; versionCode: number }): Promise<{ installationStarted: boolean }>;
  openDownloadInBrowser(options: { url: string }): Promise<{ opened: boolean }>;
  addListener(eventName: "downloadProgress", listener: (progress: NativeDownloadProgress) => void): Promise<PluginListenerHandle>;
};

const nativeAppUpdate = registerPlugin<NativeAppUpdate>("AppUpdate");
const initialDownload: DownloadState = {
  status: "idle",
  percent: null,
  downloadedBytes: 0,
  totalBytes: 0,
  bytesPerSecond: 0,
  message: null,
};
const CHECK_TIMEOUT_MS = 30_000;

function isAppVersionInfo(value: unknown): value is AppVersionInfo {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AppVersionInfo>;
  return Number.isFinite(candidate.versionCode)
    && typeof candidate.versionName === "string"
    && candidate.versionName.trim().length > 0;
}

function parseChangelogItems(changelog: string | null | undefined) {
  return (changelog ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*•]\s*/, ""))
    .filter(Boolean);
}

function formatDownloadSpeed(bytesPerSecond: number) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return null;
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(bytesPerSecond / 1024))} KB/s`;
}

export function AppUpdatePrompt() {
  const [update, setUpdate] = useState<UpdateState>(null);
  const [notice, setNotice] = useState<NoticeState>(null);
  const [checking, setChecking] = useState(false);
  const [download, setDownload] = useState<DownloadState>(initialDownload);
  const [installedVersionName, setInstalledVersionName] = useState(CURRENT_APP_VERSION_NAME);
  const downloadRunningRef = useRef(false);
  const checkAbortRef = useRef<AbortController | null>(null);
  const checkRequestIdRef = useRef(0);
  const silentCheckAbortRef = useRef(new WeakSet<AbortController>());
  const downloadBusy = download.status === "downloading" || download.status === "permission";
  const dismissibleUpdate = Boolean(update && (!update.info.forceUpdate || update.unavailable) && !downloadBusy);
  const dismissPrompt = useCallback(() => {
    if (checking) {
      const controller = checkAbortRef.current;
      if (controller) {
        silentCheckAbortRef.current.add(controller);
        controller.abort();
      }
      setChecking(false);
      return;
    }
    if (notice) {
      setNotice(null);
      return;
    }
    if (update) {
      if (!dismissibleUpdate) return false;
      setUpdate(null);
    }
  }, [checking, dismissibleUpdate, notice, update]);
  const consumePromptHistory = useLayeredHistoryMarker(
    checking || Boolean(notice) || Boolean(update),
    "starkUpdatePrompt",
    dismissPrompt,
  );
  const closePrompt = useCallback(() => {
    consumePromptHistory();
    dismissPrompt();
  }, [consumePromptHistory, dismissPrompt]);

  useEffect(() => {
    let cancelled = false;
    const native = Capacitor.isNativePlatform();
    const isKtHybrid = navigator.userAgent.includes("WottyStarkKtHybrid");
    const edition = isKtHybrid ? "ktweb" : "web";

    async function checkForUpdate(manual: boolean) {
      if (!native) {
        if (manual && !cancelled) setNotice({ title: "版本检查", message: "浏览器版不提供 APK 更新检查，请在 Android App 中使用。" });
        return;
      }

      const previousController = checkAbortRef.current;
      if (previousController) {
        silentCheckAbortRef.current.add(previousController);
        previousController.abort();
      }
      const requestId = checkRequestIdRef.current + 1;
      checkRequestIdRef.current = requestId;
      const controller = new AbortController();
      checkAbortRef.current = controller;
      const timer = window.setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
      if (manual) {
        setNotice(null);
        setUpdate(null);
        setDownload(initialDownload);
        setChecking(true);
      }
      try {
        const installed = await nativeAppUpdate.getInstalledVersion();
        if (!Number.isSafeInteger(installed.versionCode) || installed.versionCode < 1 || !installed.versionName) {
          throw new Error("Invalid installed app version");
        }
        if (!cancelled && requestId === checkRequestIdRef.current) setInstalledVersionName(installed.versionName);
        const response = await fetch(APP_UPDATE_URL, { signal: controller.signal, cache: "no-store" });
        if (cancelled || requestId !== checkRequestIdRef.current) return;
        if (!response.ok) {
          if (manual && !cancelled) setNotice({ title: "版本检查失败", message: "暂时无法连接版本服务，请稍后重试。" });
          return;
        }
        const responseInfo: unknown = await response.json();
        if (!isAppVersionInfo(responseInfo)) throw new Error("Invalid app version manifest");
        // A shared manifest must never offer another edition's APK.
        // Untagged legacy manifests are only eligible for the Web shell.
        const mismatchedEdition = responseInfo.edition
          ? responseInfo.edition !== edition
          : isKtHybrid;
        const info = mismatchedEdition
          ? { ...responseInfo, apkUrl: null }
          : responseInfo;
        if (cancelled || requestId !== checkRequestIdRef.current) return;
        const hasUpdate = hasNewerAppVersion(installed.versionCode, info);
        setAppUpdateAvailable(hasUpdate);
        if (hasUpdate) {
          if (manual || !isKtHybrid) {
            setDownload(initialDownload);
            setUpdate({ info, unavailable: !info.apkUrl });
          }
        } else if (manual) {
          setNotice({ title: "已是最新版本", message: "当前 App 版本为 " + installed.versionName + "。" });
        }
      } catch {
        if (cancelled || requestId !== checkRequestIdRef.current || silentCheckAbortRef.current.has(controller)) return;
        if (manual && !cancelled) setNotice({ title: "版本检查失败", message: "暂时无法连接版本服务，请稍后重试。" });
        // Version checks are optional and must never block the app.
      } finally {
        window.clearTimeout(timer);
        if (checkAbortRef.current === controller) checkAbortRef.current = null;
        if (manual && !cancelled && requestId === checkRequestIdRef.current) setChecking(false);
      }
    }

    function handleManualCheck() {
      void checkForUpdate(true);
    }

    window.addEventListener("stark:check-app-update", handleManualCheck);
    void checkForUpdate(false);
    return () => {
      cancelled = true;
      checkRequestIdRef.current += 1;
      const controller = checkAbortRef.current;
      if (controller) {
        silentCheckAbortRef.current.add(controller);
        controller.abort();
      }
      checkAbortRef.current = null;
      window.removeEventListener("stark:check-app-update", handleManualCheck);
    };
  }, []);

  if (checking) {
    return (
      <div className="app-update-overlay" role="status" aria-live="polite">
        <section className="app-update-card">
          <p className="app-update-kicker">版本检查</p>
          <h2>正在检查更新…</h2>
          <p className="app-update-copy">正在连接版本服务，请稍候。</p>
        </section>
      </div>
    );
  }

  if (notice) {
    return (
      <div className="app-update-overlay" role="dialog" aria-modal="true" aria-labelledby="app-update-notice-title">
        <section className="app-update-card">
          <div className="app-update-icon" aria-hidden="true">i</div>
          <p className="app-update-kicker">{notice.title}</p>
          <h2 id="app-update-notice-title">{notice.message}</h2>
          <div className="app-update-actions single">
            <button type="button" className="app-update-primary" onClick={closePrompt}>知道了</button>
          </div>
        </section>
      </div>
    );
  }

  if (!update) return null;

  const { info } = update;
  const changelogItems = parseChangelogItems(info.changelog);
  async function openDownload() {
    if (!info.apkUrl || downloadRunningRef.current) return;
    downloadRunningRef.current = true;
    setDownload({ ...initialDownload, status: "downloading" });
    let listener: PluginListenerHandle | null = null;
    try {
      listener = await nativeAppUpdate.addListener("downloadProgress", (progress) => {
        setDownload({
          status: progress.stage === "permission" ? "permission" : "downloading",
          percent: typeof progress.percent === "number" ? progress.percent : null,
          downloadedBytes: progress.downloadedBytes,
          totalBytes: progress.totalBytes,
          bytesPerSecond: progress.bytesPerSecond,
          message: null,
        });
      });
      await nativeAppUpdate.downloadAndInstall({ url: info.apkUrl, versionCode: info.versionCode });
      setDownload({ ...initialDownload, status: "ready", percent: 100 });
    } catch (error) {
      setDownload({
        status: "error",
        percent: null,
        downloadedBytes: 0,
        totalBytes: 0,
        bytesPerSecond: 0,
        message: error instanceof Error ? error.message : "下载或安装准备失败，请重试。",
      });
    } finally {
      if (listener) {
        try {
          await listener.remove();
        } catch {
          // A listener cleanup failure must not block the next attempt.
        }
      }
      downloadRunningRef.current = false;
    }
  }

  async function openBrowserDownload(event: MouseEvent<HTMLAnchorElement>) {
    if (!info.apkUrl || !Capacitor.isNativePlatform()) return;
    event.preventDefault();
    try {
      await nativeAppUpdate.openDownloadInBrowser({ url: info.apkUrl });
    } catch {
      window.open(info.apkUrl, "_blank", "noopener,noreferrer");
    }
  }

  const speedLabel = formatDownloadSpeed(download.bytesPerSecond);
  const downloadedLabel = download.totalBytes > 0
    ? `${(download.downloadedBytes / 1024 / 1024).toFixed(1)} / ${(download.totalBytes / 1024 / 1024).toFixed(1)} MB`
    : `${(download.downloadedBytes / 1024 / 1024).toFixed(1)} MB`;
  const progressLabel = download.status === "permission"
    ? "请允许星会计安装应用，返回后会继续打开安装界面。"
    : `已下载 ${download.percent === null ? downloadedLabel : `${download.percent}% · ${downloadedLabel}`}${speedLabel ? ` · ${speedLabel}` : ""}`;
  const actionLabel = download.status === "downloading" ? "正在下载…"
    : download.status === "permission" ? "等待安装授权…"
      : download.status === "ready" ? "重新打开安装"
        : download.status === "error" ? "重试下载或安装" : "下载并安装";

  return (
    <div className="app-update-overlay" role="dialog" aria-modal="true" aria-labelledby="app-update-title">
      <section className="app-update-card">
        <div className="app-update-icon" aria-hidden="true">↗</div>
        <p className="app-update-kicker">发现新版本</p>
        <h2 id="app-update-title">星会计 {info.versionName}</h2>
        <p className="app-update-copy">当前版本 {installedVersionName}，有新的 App 版本可用。</p>
        {changelogItems.length > 0 ? (
          <ul className="app-update-changelog" aria-label="更新内容">
            {changelogItems.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}
          </ul>
        ) : null}
        {update.unavailable ? <p className="app-update-unavailable">服务器尚未配置 APK 下载地址，请稍后再试。</p> : null}
        {info.apkUrl ? (
          <p className="app-update-fallback">
            如下载失败，请到<a href={info.apkUrl} target="_blank" rel="noreferrer" onClick={(event) => void openBrowserDownload(event)}>下载更新</a>。
          </p>
        ) : null}
        {downloadBusy ? (
          <div className="app-update-download" aria-live="polite">
            {download.status === "downloading" ? (
              <div className="app-update-progress" role="progressbar" aria-label="安装包下载进度" aria-valuenow={download.percent ?? undefined} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ width: `${download.percent ?? 0}%` }} />
              </div>
            ) : null}
            <p>{progressLabel}</p>
          </div>
        ) : null}
        {download.status === "ready" ? <p className="app-update-copy">系统安装界面已打开，请按提示完成安装。</p> : null}
        {download.status === "error" ? <p className="app-update-unavailable" role="alert">{download.message}</p> : null}
        <div className="app-update-actions">
          <button type="button" className="app-update-later" onClick={closePrompt} disabled={!dismissibleUpdate}>稍后</button>
          <button type="button" className="app-update-primary" onClick={() => void openDownload()} disabled={update.unavailable || downloadBusy}>{actionLabel}</button>
        </div>
      </section>
    </div>
  );
}
