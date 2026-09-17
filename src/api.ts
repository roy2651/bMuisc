// Tauri Command 封装与数据类型（与 Rust 侧 serde camelCase 对应）

import { invoke } from '@tauri-apps/api/core';

export interface PageInfo {
  page: number;
  part: string;
  cid: number;
  duration: number;
}

export interface EpisodeInfo {
  bvid: string;
  cid: number;
  title: string;
  duration: number;
}

export interface SeasonInfo {
  title: string;
  episodes: EpisodeInfo[];
}

export interface ViewInfo {
  bvid: string;
  title: string;
  owner: string;
  cover: string;
  duration: number;
  pages: PageInfo[];
  season: SeasonInfo | null;
}

export interface StreamItem {
  key: string;
  id: number;
  codecs: string;
  bandwidth: number;
}

export interface StreamsInfo {
  audio: StreamItem[];
  video: { codecs: string; width: number; height: number; bandwidth: number }[];
}

export function extractBvid(input: string): string | null {
  const m = input.match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : null;
}

export function resolveView(input: string): Promise<ViewInfo> {
  return invoke('resolve_view', { input });
}

export function resolveStreams(bvid: string, cid: number): Promise<StreamsInfo> {
  return invoke('resolve_streams', { bvid, cid });
}

export function proxyPort(): Promise<number> {
  return invoke('proxy_port');
}
