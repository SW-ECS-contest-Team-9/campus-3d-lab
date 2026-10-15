package kr.campus.lab;

import android.app.Activity;
import android.os.Bundle;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.util.Collections;

/** WebView 시험 앱: 인텐트 extra 로 주소·레이어·문서 시작 스크립트를 받아 띄우고, 콘솔·렌더러 죽음을 logcat LAB 로 남김. */
public class MainActivity extends Activity {
  static final String TAG = "LAB";
  private FrameLayout root;
  private long t0;

  @Override protected void onCreate(Bundle b) {
    super.onCreate(b);
    WebView.setWebContentsDebuggingEnabled(true);
    root = new FrameLayout(this);
    setContentView(root);
    load();
  }

  @Override protected void onNewIntent(android.content.Intent i) { super.onNewIntent(i); setIntent(i); root.removeAllViews(); load(); }

  private void load() {
    String url = getIntent().getStringExtra("url");
    if (url == null) url = "about:blank";
    String layer = getIntent().getStringExtra("layer"); // hw | sw | none(기본)
    String inject = getIntent().getStringExtra("inject"); // base64 JS, 문서 시작마다
    boolean preRaster = getIntent().getBooleanExtra("preraster", false);
    WebView w = new WebView(this);
    WebSettings s = w.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
    s.setMediaPlaybackRequiresUserGesture(false);
    if (preRaster) s.setOffscreenPreRaster(true);
    if ("hw".equals(layer)) w.setLayerType(View.LAYER_TYPE_HARDWARE, null);
    else if ("sw".equals(layer)) w.setLayerType(View.LAYER_TYPE_SOFTWARE, null);
    w.addJavascriptInterface(new Object() {
      @JavascriptInterface public void post(String m) { Log.i(TAG, "MSG +" + (System.currentTimeMillis() - t0) + "ms " + m); }
    }, "LabNative");
    String bridge = "window.ReactNativeWebView={postMessage:function(s){LabNative.post(s)}};";
    String js = bridge + (inject != null ? new String(Base64.decode(inject, Base64.DEFAULT)) : "");
    if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
      WebViewCompat.addDocumentStartJavaScript(w, js, Collections.singleton("*"));
    } else Log.w(TAG, "DOCUMENT_START_SCRIPT unsupported");
    w.setWebChromeClient(new WebChromeClient() {
      @Override public boolean onConsoleMessage(ConsoleMessage m) {
        Log.i(TAG, "CONSOLE " + m.messageLevel() + " " + m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
        return true;
      }
    });
    w.setWebViewClient(new WebViewClient() {
      @Override public void onPageFinished(WebView v, String u) { Log.i(TAG, "PAGE_FINISHED +" + (System.currentTimeMillis() - t0) + "ms " + u); }
      @Override public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail d) {
        Log.e(TAG, "RENDER_GONE crashed=" + d.didCrash() + " prio=" + d.rendererPriorityAtExit());
        root.removeView(v); v.destroy();
        return true;
      }
    });
    root.addView(w, new FrameLayout.LayoutParams(-1, -1));
    t0 = System.currentTimeMillis();
    Log.i(TAG, "LOAD " + url + " layer=" + layer + " preraster=" + preRaster + " webview=" + WebViewCompat.getCurrentWebViewPackage(this).versionName);
    w.loadUrl(url);
  }
}
