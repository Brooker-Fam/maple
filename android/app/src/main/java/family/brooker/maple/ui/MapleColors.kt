package family.brooker.maple.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

data class MapleColors(
    val bg: Color,
    val ink: Color,
    val ink2: Color,
    val accent: Color,
    val onAccent: Color,
)

private val Day = MapleColors(
    bg = Color(0xFFF6F3EC),
    ink = Color(0xFF1C2619),
    ink2 = Color(0xFF5B6356),
    accent = Color(0xFF1D4420),
    onAccent = Color(0xFFFFFFFF),
)

private val Dark = MapleColors(
    bg = Color(0xFF0E1310),
    ink = Color(0xFFECE7DC),
    ink2 = Color(0xFFA7ABA0),
    accent = Color(0xFFB4CC96),
    onAccent = Color(0xFF16210F),
)

@Composable
fun mapleColors(): MapleColors = if (isSystemInDarkTheme()) Dark else Day
