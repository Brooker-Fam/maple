package app.maplebaby.web

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.result.contract.ActivityResultContract
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import java.io.File

object FilePicker {
    private const val ANY_FILE = "*/*"
    private val MIME_TYPE = Regex("^[a-z0-9!#$&^_.+-]+/([a-z0-9!#$&^_.+-]+|\\*)$")

    fun mimeTypes(acceptTypes: Array<String>?): Array<String> {
        val types = acceptTypes.orEmpty().map { it.trim().lowercase() }.filter { it.isNotEmpty() }.distinct()
        if (types.isEmpty() || types.any { !MIME_TYPE.matches(it) }) return arrayOf(ANY_FILE)
        val topLevel = types.map { it.substringBefore('/') }.distinct()
        return when {
            types.size == 1 -> arrayOf(types.single())
            topLevel.size == 1 -> arrayOf("${topLevel.single()}/*")
            else -> types.toTypedArray()
        }
    }

    fun wantsCamera(captureEnabled: Boolean, acceptTypes: Array<String>?): Boolean =
        captureEnabled && mimeTypes(acceptTypes).all { it.startsWith("image/") }

    fun newPhotoUri(context: Context): Uri {
        val dir = File(context.cacheDir, "camera")
        dir.deleteRecursively()
        dir.mkdirs()
        val photo = File(dir, "photo-${System.currentTimeMillis()}.jpg")
        return FileProvider.getUriForFile(context, "${context.packageName}.files", photo)
    }

    class Request(val mimeTypes: Array<String>, val allowMultiple: Boolean)

    class PickFiles : ActivityResultContract<Request, List<Uri>>() {
        private val results = ActivityResultContracts.GetMultipleContents()

        override fun createIntent(context: Context, input: Request): Intent =
            Intent(Intent.ACTION_GET_CONTENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType(input.mimeTypes.singleOrNull() ?: ANY_FILE)
                .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, input.allowMultiple)
                .apply { if (input.mimeTypes.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, input.mimeTypes) }

        override fun parseResult(resultCode: Int, intent: Intent?): List<Uri> =
            results.parseResult(resultCode, intent)
    }
}
