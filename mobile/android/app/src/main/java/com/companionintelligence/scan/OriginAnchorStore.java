package com.companionintelligence.scan;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * The origin anchor's record, kept as one small JSON file in the app's files directory. The ScanAR
 * plugin writes it when the origin is set and reads it back for getOriginAnchor(). The file has no
 * Android types in it, so the round trip is unit-tested on the JVM (OriginAnchorStoreTest).
 *
 * The position and rotation are the pose the origin was set at, in the frame of the ARCore session
 * that set it. A later session starts a new frame, so a record read back there is only a record. The
 * plugin reports that with `current: false`.
 *
 * Format, version 1:
 *   {"version":1,"position":[x,y,z],"rotation":[x,y,z,w],"heading":null}
 */
final class OriginAnchorStore {

    static final String FILE_NAME = "scan-origin-anchor.json";
    static final int VERSION = 1;

    /** One saved origin. `heading` is whatever number the caller gave with it, or null. */
    static final class Record {
        final double[] position;
        final double[] rotation;
        final Double heading;

        Record(double[] position, double[] rotation, Double heading) {
            if (position == null || position.length != 3) {
                throw new IllegalArgumentException("an origin position is three numbers");
            }
            if (rotation == null || rotation.length != 4) {
                throw new IllegalArgumentException("an origin rotation is four numbers");
            }
            requireFinite(position);
            requireFinite(rotation);
            if (heading != null && !isFinite(heading)) {
                throw new IllegalArgumentException("an origin heading must be a finite number");
            }
            this.position = position.clone();
            this.rotation = rotation.clone();
            this.heading = heading;
        }
    }

    private OriginAnchorStore() {}

    /** The saved record, or null when no origin has been saved. Throws when the file exists but is not a record. */
    static synchronized Record read(File file) throws IOException {
        if (!file.exists()) {
            return null;
        }
        return decode(new String(readAll(file), StandardCharsets.UTF_8));
    }

    /** Replaces the file with the record. The text goes to a temporary file first, then takes the file's place. */
    static synchronized void write(File file, Record record) throws IOException {
        byte[] bytes = encode(record).getBytes(StandardCharsets.UTF_8);
        File temporary = new File(file.getParentFile(), file.getName() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(temporary)) {
            out.write(bytes);
            out.flush();
            out.getFD().sync();
        }
        if (file.exists() && !file.delete()) {
            throw new IOException("could not replace " + file.getName());
        }
        if (!temporary.renameTo(file)) {
            throw new IOException("could not save " + file.getName());
        }
    }

    static String encode(Record record) {
        StringBuilder out = new StringBuilder(160);
        out.append("{\"version\":").append(VERSION);
        out.append(",\"position\":");
        appendNumbers(out, record.position);
        out.append(",\"rotation\":");
        appendNumbers(out, record.rotation);
        out.append(",\"heading\":");
        out.append(record.heading == null ? "null" : Double.toString(record.heading));
        out.append('}');
        return out.toString();
    }

    static Record decode(String json) {
        Reader in = new Reader(json);
        boolean sawVersion = false;
        double[] position = null;
        double[] rotation = null;
        Double heading = null;
        in.expect('{');
        if (!in.consume('}')) {
            do {
                String key = in.key();
                in.expect(':');
                if (key.equals("version")) {
                    double version = in.number();
                    if (version != VERSION) {
                        throw new IllegalArgumentException("unsupported origin file version: " + version);
                    }
                    sawVersion = true;
                } else if (key.equals("position")) {
                    position = in.numbers();
                } else if (key.equals("rotation")) {
                    rotation = in.numbers();
                } else if (key.equals("heading")) {
                    heading = in.numberOrNull();
                } else {
                    throw new IllegalArgumentException("unknown field in the origin file: " + key);
                }
            } while (in.consume(','));
            in.expect('}');
        }
        in.end();
        if (!sawVersion || position == null || rotation == null) {
            throw new IllegalArgumentException("the origin file is missing its version, position or rotation");
        }
        return new Record(position, rotation, heading);
    }

    private static void appendNumbers(StringBuilder out, double[] values) {
        out.append('[');
        for (int i = 0; i < values.length; i++) {
            if (i > 0) {
                out.append(',');
            }
            // Double.toString round-trips exactly, and the constructor has already refused NaN and infinity.
            out.append(Double.toString(values[i]));
        }
        out.append(']');
    }

    private static byte[] readAll(File file) throws IOException {
        try (InputStream in = new FileInputStream(file)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[1024];
            int count;
            while ((count = in.read(buffer)) != -1) {
                out.write(buffer, 0, count);
            }
            return out.toByteArray();
        }
    }

    private static void requireFinite(double[] values) {
        for (double value : values) {
            if (!isFinite(value)) {
                throw new IllegalArgumentException("an origin number is not finite");
            }
        }
    }

    private static boolean isFinite(double value) {
        return !Double.isNaN(value) && !Double.isInfinite(value);
    }

    /** A reader for the subset of JSON this file uses: one object of numbers, number arrays, and null. */
    private static final class Reader {
        private final String text;
        private int at;

        Reader(String text) {
            this.text = text;
        }

        void expect(char c) {
            skipSpace();
            if (at >= text.length() || text.charAt(at) != c) {
                throw new IllegalArgumentException("expected '" + c + "' at " + at);
            }
            at++;
        }

        boolean consume(char c) {
            skipSpace();
            if (at < text.length() && text.charAt(at) == c) {
                at++;
                return true;
            }
            return false;
        }

        /** A key: a quoted name with no escapes, which this format never uses. */
        String key() {
            expect('"');
            int start = at;
            while (at < text.length() && text.charAt(at) != '"') {
                if (text.charAt(at) == '\\') {
                    throw new IllegalArgumentException("escapes are not used in the origin file");
                }
                at++;
            }
            if (at >= text.length()) {
                throw new IllegalArgumentException("an unterminated key in the origin file");
            }
            String key = text.substring(start, at);
            at++;
            return key;
        }

        double number() {
            skipSpace();
            int start = at;
            while (at < text.length() && "+-.0123456789eE".indexOf(text.charAt(at)) >= 0) {
                at++;
            }
            if (start == at) {
                throw new IllegalArgumentException("expected a number at " + at);
            }
            double value = Double.parseDouble(text.substring(start, at));
            if (!isFinite(value)) {
                throw new IllegalArgumentException("a number in the origin file is not finite");
            }
            return value;
        }

        double[] numbers() {
            expect('[');
            List<Double> values = new ArrayList<>();
            if (!consume(']')) {
                do {
                    values.add(number());
                } while (consume(','));
                expect(']');
            }
            double[] out = new double[values.size()];
            for (int i = 0; i < out.length; i++) {
                out[i] = values.get(i);
            }
            return out;
        }

        Double numberOrNull() {
            skipSpace();
            if (text.startsWith("null", at)) {
                at += 4;
                return null;
            }
            return number();
        }

        void end() {
            skipSpace();
            if (at != text.length()) {
                throw new IllegalArgumentException("unexpected text after the origin record");
            }
        }

        private void skipSpace() {
            while (at < text.length() && " \t\r\n".indexOf(text.charAt(at)) >= 0) {
                at++;
            }
        }
    }
}
