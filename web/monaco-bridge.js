/* 真 Monaco 桥接 —— 从 CodeBuddy Web UI npm 包提取的内核 ESM chunk */
(function(global){
'use strict';
global.__monacoReady=false;
global.__monacoAPI=null;
// 全局 Monaco 环境（必须在 module 加载前设置）
global._VSCODE_NLS_MESSAGES=[];
global._VSCODE_NLS_LANGUAGE='en';
global._VSCODE_PACKAGE_JSON={};
global._VSCODE_PRODUCT_JSON={};
global._VSCODE_FILE_ROOT='';
global.MonacoEnvironment={getWorkerUrl:function(){ return './monaco/editor.worker-O-CH8JUO.js'; }};
})(window);
