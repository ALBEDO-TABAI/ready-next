import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isReusableCaptureTabUrl } from '../main/modules/browser-engine/capture-url-utils'

describe('browser capture URL reuse matching', () => {
  it('reuses only the same xiaohongshu profile tab', () => {
    assert.equal(
      isReusableCaptureTabUrl(
        'https://www.xiaohongshu.com/user/profile/5b6af7459e8ccb000181bd60',
        'https://www.xiaohongshu.com/user/profile/5b6af7459e8ccb000181bd60?xsec_token=abc',
      ),
      true,
    )
    assert.equal(
      isReusableCaptureTabUrl(
        'https://www.xiaohongshu.com/user/profile/5b6af7459e8ccb000181bd60',
        'https://www.xiaohongshu.com/user/profile/5fc91b41000000000101fe32',
      ),
      false,
    )
  })

  it('matches weibo profile variants by uid', () => {
    assert.equal(
      isReusableCaptureTabUrl('https://weibo.com/u/6182606334', 'https://m.weibo.cn/profile/6182606334'),
      true,
    )
    assert.equal(
      isReusableCaptureTabUrl(
        'https://weibo.com/u/6182606334',
        'https://m.weibo.cn/p/index?containerid=1005056182606334',
      ),
      true,
    )
  })

  it('matches douyin user routes by sec_uid and rejects unrelated tabs', () => {
    assert.equal(
      isReusableCaptureTabUrl(
        'https://www.iesdouyin.com/share/user/demo?sec_uid=MS4wLjABAAAATEST',
        'https://www.douyin.com/user/MS4wLjABAAAATEST',
      ),
      true,
    )
    assert.equal(
      isReusableCaptureTabUrl(
        'https://www.iesdouyin.com/share/user/demo?sec_uid=MS4wLjABAAAATEST',
        'https://www.douyin.com/user/MS4wLjABAAAADIFFERENT',
      ),
      false,
    )
  })
})

