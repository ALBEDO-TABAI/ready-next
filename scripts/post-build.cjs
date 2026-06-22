const { execSync } = require('child_process');
const path = require('path');

exports.default = async function(context) {
  if (process.platform !== 'darwin') {
    console.log('Skipping macOS ad-hoc signing on non-darwin platform');
    return;
  }

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  console.log('🔐 开始 ad-hoc 签名...');

  try {
    // 对应用进行 ad-hoc 签名
    execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
    console.log('✅ 应用签名完成');
  } catch (error) {
    console.error('❌ 签名失败:', error.message);
    throw error;
  }
};
