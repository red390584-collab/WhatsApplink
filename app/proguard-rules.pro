# JavascriptInterface methods are called reflectively from the WebView.
-keepclassmembers class com.hybrid.webchat.MainActivity$Bridge {
    public *;
}
