package family.brooker.maple.web

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FilePickerTest {
    @Test
    fun followsThePagesAcceptList() {
        assertArrayEquals(arrayOf("image/*"), FilePicker.mimeTypes(arrayOf("image/*")))
        assertArrayEquals(arrayOf("image/*"), FilePicker.mimeTypes(arrayOf("image/jpeg", " image/png")))
        assertArrayEquals(arrayOf("image/png", "text/csv"), FilePicker.mimeTypes(arrayOf("image/png", "text/csv")))
    }

    @Test
    fun opensEveryFileWhenTheListCannotBeFiltered() {
        assertArrayEquals(arrayOf("*/*"), FilePicker.mimeTypes(null))
        assertArrayEquals(arrayOf("*/*"), FilePicker.mimeTypes(arrayOf("")))
        assertArrayEquals(arrayOf("*/*"), FilePicker.mimeTypes(arrayOf(".csv")))
    }

    @Test
    fun usesTheCameraOnlyForAPhotoCapture() {
        assertTrue(FilePicker.wantsCamera(true, arrayOf("image/*")))
        assertFalse(FilePicker.wantsCamera(false, arrayOf("image/*")))
        assertFalse(FilePicker.wantsCamera(true, arrayOf("video/*")))
        assertFalse(FilePicker.wantsCamera(true, null))
    }
}
