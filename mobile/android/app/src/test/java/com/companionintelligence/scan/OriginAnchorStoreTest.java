package com.companionintelligence.scan;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.fail;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** The origin file's round trip, on the JVM: no device or Context is needed. */
public class OriginAnchorStoreTest {

    @Rule
    public TemporaryFolder folder = new TemporaryFolder();

    private static OriginAnchorStore.Record record(Double heading) {
        return new OriginAnchorStore.Record(
            new double[] { 0.125, -1.5, 2.0000001 },
            new double[] { 0.0, 0.70710678, 0.0, 0.70710678 },
            heading);
    }

    @Test
    public void aRecordSurvivesTheFileRoundTrip() throws IOException {
        File file = new File(folder.getRoot(), OriginAnchorStore.FILE_NAME);
        OriginAnchorStore.Record original = record(42.5);

        OriginAnchorStore.write(file, original);
        OriginAnchorStore.Record back = OriginAnchorStore.read(file);

        assertNotNull(back);
        assertArrayEquals(original.position, back.position, 0.0);
        assertArrayEquals(original.rotation, back.rotation, 0.0);
        assertEquals(original.heading, back.heading);
    }

    @Test
    public void aNullHeadingRoundTrips() throws IOException {
        File file = new File(folder.getRoot(), OriginAnchorStore.FILE_NAME);
        OriginAnchorStore.write(file, record(null));

        OriginAnchorStore.Record back = OriginAnchorStore.read(file);

        assertNotNull(back);
        assertNull(back.heading);
    }

    @Test
    public void aSecondWriteReplacesTheFirst() throws IOException {
        File file = new File(folder.getRoot(), OriginAnchorStore.FILE_NAME);
        OriginAnchorStore.write(file, record(1.0));
        OriginAnchorStore.write(file, new OriginAnchorStore.Record(
            new double[] { 9.0, 8.0, 7.0 }, new double[] { 0.0, 0.0, 0.0, 1.0 }, 270.0));

        OriginAnchorStore.Record back = OriginAnchorStore.read(file);

        assertNotNull(back);
        assertArrayEquals(new double[] { 9.0, 8.0, 7.0 }, back.position, 0.0);
        assertEquals(Double.valueOf(270.0), back.heading);
        assertFalse("no temporary file is left behind", new File(folder.getRoot(), OriginAnchorStore.FILE_NAME + ".tmp").exists());
    }

    @Test
    public void aMissingFileReadsAsNoOrigin() throws IOException {
        File file = new File(folder.getRoot(), OriginAnchorStore.FILE_NAME);

        assertNull(OriginAnchorStore.read(file));
    }

    @Test
    public void theFormatIsTheDocumentedJson() {
        String text = OriginAnchorStore.encode(new OriginAnchorStore.Record(
            new double[] { 1, 2, 3 }, new double[] { 0, 0, 0, 1 }, null));

        assertEquals("{\"version\":1,\"position\":[1.0,2.0,3.0],\"rotation\":[0.0,0.0,0.0,1.0],\"heading\":null}", text);
    }

    @Test
    public void aFileThatIsNotARecordIsRejected() throws IOException {
        File file = new File(folder.getRoot(), OriginAnchorStore.FILE_NAME);
        Files.write(file.toPath(), "not json".getBytes(StandardCharsets.UTF_8));

        try {
            OriginAnchorStore.read(file);
            fail("a file that is not a record was read");
        } catch (IllegalArgumentException expected) {
            // expected
        }
    }

    @Test
    public void malformedAndFutureRecordsAreRejected() {
        assertRejected("");
        assertRejected("{\"version\":2,\"position\":[0,0,0],\"rotation\":[0,0,0,1],\"heading\":null}");
        assertRejected("{\"position\":[0,0,0],\"rotation\":[0,0,0,1],\"heading\":null}");
        assertRejected("{\"version\":1,\"position\":[0,0],\"rotation\":[0,0,0,1],\"heading\":null}");
        assertRejected("{\"version\":1,\"position\":[0,0,0],\"heading\":null}");
        assertRejected("{\"version\":1,\"position\":[0,0,0],\"rotation\":[0,0,0,1],\"heading\":null} trailing");
        assertRejected("{\"version\":1,\"position\":[0,0,0],\"rotation\":[0,0,0,1],\"heading\":null,\"extra\":1}");
        assertRejected("{\"version\":1,\"position\":[NaN,0,0],\"rotation\":[0,0,0,1],\"heading\":null}");
        assertRejected("{\"version\":1,\"position\":[1e400,0,0],\"rotation\":[0,0,0,1],\"heading\":null}");
        assertRejected("{\"version\":1,\"position\":[0,0,0],\"rotation\":[0,0,0,1],\"heading\":null");
    }

    @Test
    public void nonFiniteNumbersAreRefusedBeforeAnythingIsWritten() {
        try {
            new OriginAnchorStore.Record(new double[] { Double.NaN, 0, 0 }, new double[] { 0, 0, 0, 1 }, null);
            fail("a NaN position was accepted");
        } catch (IllegalArgumentException expected) {
            // expected
        }
        try {
            new OriginAnchorStore.Record(new double[] { 0, 0, 0 }, new double[] { 0, 0, 0, 1 }, Double.POSITIVE_INFINITY);
            fail("an infinite heading was accepted");
        } catch (IllegalArgumentException expected) {
            // expected
        }
    }

    private static void assertRejected(String json) {
        try {
            OriginAnchorStore.decode(json);
            fail("accepted: " + json);
        } catch (IllegalArgumentException expected) {
            // expected
        }
    }
}
