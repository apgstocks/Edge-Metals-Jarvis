package com.edgemetals.loads;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Registered BEFORE super.onCreate so the bridge sees it while the
        // WebView is being built. Registering afterwards leaves window.Capacitor
        // .Plugins.WakeWord undefined for the first page load, which is exactly
        // the class of silent, load-order failure this feature has already
        // shipped once (voice-machine.js loading after the script that read it).
        registerPlugin(WakeWordPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
