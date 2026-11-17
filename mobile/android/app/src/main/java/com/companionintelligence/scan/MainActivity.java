package com.companionintelligence.scan;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // A local plugin has to be registered before the bridge loads, so the web app can reach it.
        registerPlugin(ScanARPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
