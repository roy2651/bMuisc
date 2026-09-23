// 自动更新（Windows 先行）：tauri-plugin-updater + GitHub Releases latest.json。
// 检查与下载的网络请求都在 Rust 侧进行，不受前端 CSP 限制；更新包用 minisign
// 公钥校验（公钥随应用发布，私钥只在 CI Secrets）。Windows 安装器为 passive
// 模式（/P /UPDATE /R），安装完成后自动退出并重启应用；macOS 公证前不开放更新。
import { check, type Update } from '@tauri-apps/plugin-updater';

const AUTO_KEY = 'bmuisc.autoupdate'; // 启动时自动检查：'1' 开（默认）/ '0' 关

export function autoUpdateEnabled(): boolean {
  return localStorage.getItem(AUTO_KEY) !== '0';
}

export function setAutoUpdateEnabled(on: boolean): void {
  localStorage.setItem(AUTO_KEY, on ? '1' : '0');
}

// 更新入口条件：生产构建 + Windows。开发模式不检查（会真连 latest.json，
// 版本低于线上时可能触发安装流程）；macOS 未公证，更新后的新包会被
// Gatekeeper 拦截，等公证方案落地再放开。
export function updaterSupported(): boolean {
  return import.meta.env.PROD && /Windows/i.test(navigator.userAgent);
}

// 返回 null = 已是最新；网络失败会抛错，由调用方决定提示方式
export function checkForUpdate(): Promise<Update | null> {
  if (!updaterSupported()) return Promise.resolve(null);
  // 15 秒超时：清单很小，超时基本等于断网，失败走静默/重试，不让启动检查挂起
  return check({ timeout: 15_000 });
}
