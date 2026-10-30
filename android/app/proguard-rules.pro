# Proguard rules for Gaming Hub Android
# Keeps WebRTC, LiveKit and JavaScript bridge models

-keepattributes *Annotation*
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

-keep class ng.gaminghub.app.** { *; }
-keep class io.livekit.android.** { *; }
-keep class org.webrtc.** { *; }
