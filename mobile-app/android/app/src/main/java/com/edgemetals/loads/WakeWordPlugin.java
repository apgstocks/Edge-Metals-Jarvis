package com.edgemetals.loads;

import android.Manifest;
import android.content.pm.PackageManager;
import android.content.res.AssetManager;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

import ai.picovoice.porcupine.Porcupine;
import ai.picovoice.porcupine.PorcupineManager;
import ai.picovoice.porcupine.PorcupineManagerCallback;

/**
 * WakeWord — on-device keyword spotting, via Picovoice Porcupine.
 *
 * WHY THIS EXISTS
 * ---------------
 * Eleven builds of "Hey Jarvis" were attempted on top of Android's
 * SpeechRecognizer, driven in a restart loop from JavaScript. Every one failed,
 * and Apsara's logs showed why each time:
 *
 *   - partial results omit the LAST word, so a two-word wake phrase never
 *     contains the name
 *   - the "stopped" event fires while transcription is still in flight
 *   - start() is not driveable in a loop; on her device it sometimes never
 *     resolves at all
 *   - there is no continuous mode, so "always listening" IS a restart loop
 *
 * None of these are bugs. SpeechRecognizer is a transcription API and its own
 * documentation says it does not support wake-word detection. The research
 * literature settled this a decade ago: Chen, Parada & Heigold (ICASSP 2014)
 * and Sainath & Parada (INTERSPEECH 2015) treat keyword spotting as
 * small-footprint CLASSIFICATION of one phrase — no vocabulary, no language
 * model, no decoding graph — which is what makes it cheap enough to run
 * continuously and accurate enough to trust.
 *
 * See docs/voice-wake-word-research.md for the full review.
 *
 * WHAT CHANGES
 * ------------
 * Porcupine owns the microphone itself and runs a small neural net over the
 * audio stream. There is no session, no endpointer, no partial results, and
 * nothing for JavaScript to drive. It calls back when the word is heard.
 * Published benchmark: 97.1% detection at 1 false alarm per 10 hours at 10dB
 * SNR — against roughly zero for what this replaces.
 *
 * TWO KEYWORDS
 * ------------
 * "Jarvis" is BUILT IN to the SDK, so it costs nothing and needs no model
 * file. "Scout" is not, so it needs a custom .ppn trained on the Picovoice
 * console and dropped into app/src/main/assets/. This plugin loads whatever
 * custom .ppn files it finds there and adds them alongside the built-in — so
 * "Scout" starts working the moment the file exists, with no code change.
 */
@CapacitorPlugin(name = "WakeWord")
public class WakeWordPlugin extends Plugin {

    private PorcupineManager manager = null;
    private List<String> activeLabels = new ArrayList<>();

    /** Is the engine present and is the mic permitted? Cheap, no key needed. */
    @PluginMethod
    public void available(PluginCall call) {
        JSObject ret = new JSObject();
        boolean mic = ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
        ret.put("available", true);
        ret.put("micGranted", mic);
        ret.put("builtIn", "jarvis");
        ret.put("customModels", customModelNames());
        call.resolve(ret);
    }

    /**
     * Start listening. Requires an AccessKey from console.picovoice.ai.
     *
     * Sensitivity is per keyword, 0..1. Higher catches more and false-triggers
     * more. 0.5 is Picovoice's default and the benchmark point; this uses a
     * slightly lower value for the custom model because a false wake in this
     * app opens the microphone and can reach the brain that messages truckers.
     */
    @PluginMethod
    public void start(PluginCall call) {
        String accessKey = call.getString("accessKey", "");
        if (accessKey == null || accessKey.trim().isEmpty()) {
            call.reject("no-access-key");
            return;
        }
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            call.reject("no-mic-permission");
            return;
        }

        stopManager();   // never run two engines on one microphone

        try {
            List<Porcupine.BuiltInKeyword> builtIns = new ArrayList<>();
            List<String> customPaths = new ArrayList<>();
            activeLabels = new ArrayList<>();
            List<Float> sensitivities = new ArrayList<>();

            builtIns.add(Porcupine.BuiltInKeyword.JARVIS);
            activeLabels.add("jarvis");
            sensitivities.add(0.55f);

            // Any custom model she has added. Named by file, so
            // "hey_scout_android.ppn" reports as "hey_scout".
            for (String name : customModelNames()) {
                String path = copyAssetToFiles(name);
                if (path != null) {
                    customPaths.add(path);
                    activeLabels.add(name.replace("_android.ppn", "").replace(".ppn", ""));
                    sensitivities.add(0.5f);
                }
            }

            PorcupineManager.Builder builder = new PorcupineManager.Builder()
                    .setAccessKey(accessKey.trim());

            if (!builtIns.isEmpty()) {
                builder.setKeywords(builtIns.toArray(new Porcupine.BuiltInKeyword[0]));
            }
            if (!customPaths.isEmpty()) {
                builder.setKeywordPaths(customPaths.toArray(new String[0]));
            }
            float[] sens = new float[sensitivities.size()];
            for (int i = 0; i < sens.length; i++) sens[i] = sensitivities.get(i);
            builder.setSensitivities(sens);

            final PorcupineManagerCallback cb = new PorcupineManagerCallback() {
                @Override
                public void invoke(int keywordIndex) {
                    JSObject ev = new JSObject();
                    String label = (keywordIndex >= 0 && keywordIndex < activeLabels.size())
                            ? activeLabels.get(keywordIndex) : "unknown";
                    ev.put("keyword", label);
                    ev.put("index", keywordIndex);
                    // Fired on the engine's thread; notifyListeners marshals it.
                    notifyListeners("wake", ev);
                }
            };

            manager = builder.build(getContext(), cb);
            manager.start();

            JSObject ret = new JSObject();
            ret.put("started", true);
            ret.put("keywords", String.join(",", activeLabels));
            call.resolve(ret);
        } catch (Exception e) {
            // The message matters: an invalid or expired key, an exhausted
            // free tier and a missing model all fail here and need different
            // answers from the person holding the phone.
            manager = null;
            call.reject(e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopManager();
        call.resolve();
    }

    /** Detection must pause while the app is speaking, or it hears itself. */
    @PluginMethod
    public void pause(PluginCall call) {
        try { if (manager != null) manager.stop(); } catch (Exception ignored) {}
        call.resolve();
    }

    @PluginMethod
    public void resume(PluginCall call) {
        try { if (manager != null) manager.start(); } catch (Exception e) {
            call.reject(e.getMessage());
            return;
        }
        call.resolve();
    }

    private void stopManager() {
        if (manager == null) return;
        try { manager.stop(); } catch (Exception ignored) {}
        try { manager.delete(); } catch (Exception ignored) {}
        manager = null;
    }

    /** Custom .ppn files shipped in assets. Empty until she adds one. */
    private List<String> customModelNames() {
        List<String> out = new ArrayList<>();
        try {
            AssetManager am = getContext().getAssets();
            String[] files = am.list("");
            if (files == null) return out;
            for (String f : files) {
                if (f.endsWith(".ppn")) out.add(f);
            }
        } catch (Exception ignored) {}
        return out;
    }

    /** Porcupine needs a real file path, not an asset stream. */
    private String copyAssetToFiles(String name) {
        try {
            File out = new File(getContext().getFilesDir(), name);
            if (out.exists() && out.length() > 0) return out.getAbsolutePath();
            try (InputStream in = getContext().getAssets().open(name);
                 OutputStream os = new FileOutputStream(out)) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
            }
            return out.getAbsolutePath();
        } catch (Exception e) {
            return null;
        }
    }

    @Override
    protected void handleOnDestroy() {
        stopManager();
    }
}
