// campus.glb 를 앱 묶음의 자산으로
const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push('glb');
module.exports = config;
