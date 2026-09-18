//! 实网冒烟测试：验证 Rust 解析链路（http1_only 修复后）匿名通过 B 站风控。
//! 依赖外网与 B 站接口可用性，接口变更或离线时可能失败，仅作人工核对用途。

use bmuisc_lib::bilibili;

const SAMPLE_BV: &str = "BV1cLeE6yE9R";

#[test]
fn extract_bvid_from_url() {
    assert_eq!(
        bilibili::extract_bvid("https://www.bilibili.com/video/BV1cLeE6yE9R/").unwrap(),
        SAMPLE_BV
    );
    assert!(bilibili::extract_bvid("没有编号").is_err());
}

#[tokio::test]
async fn live_view_and_streams() {
    let info = bilibili::view(SAMPLE_BV)
        .await
        .expect("view 解析应通过风控");
    assert_eq!(info.bvid, SAMPLE_BV);
    assert!(!info.pages.is_empty(), "应至少有一个分 P");
    let cid = info.pages[0].cid;
    assert_ne!(cid, 0, "cid 应有效");

    let streams = bilibili::streams(SAMPLE_BV, cid)
        .await
        .expect("playurl 应返回 DASH 分轨");
    assert!(!streams.audio.is_empty(), "应存在独立音频轨");
    // 音频轨应已登记进代理注册表（key 非空）
    assert!(streams.audio[0].key.starts_with('s'));
}
