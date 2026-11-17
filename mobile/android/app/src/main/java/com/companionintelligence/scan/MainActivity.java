package com.companionintelligence.scan;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // The app's own plugins are registered before super.onCreate(), which creates the bridge.
        registerPlugin(ArSessionPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
