/**
 * Assertions for the WHO growth standards (src/lib/maple/growth.ts with the
 * who-girls.ts and who-boys.ts tables): each table matches the WHO expanded
 * table it was copied from, the math reproduces WHO's own z-score and
 * percentile values for girls and boys, the baby's sex picks the standard
 * (none without one), and the growth chart draws the standard it picked.
 *
 *   npx tsx scripts/maple-growth-check.ts      (or pnpm check:maple-growth)
 *
 * Pure: no database and no network. One PASS/FAIL line per case, exit 1 on
 * any failure. Babies are made up. The reference rows are copied from WHO's
 * expanded tables (z-scores and percentiles, 0-5 years, by day) at
 * https://www.who.int/tools/child-growth-standards/standards
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import GrowthChart from "@/components/maple/GrowthChart";
import {
  CURVE_PERCENTILES,
  curves,
  implausibleOnBoth,
  percentileFor,
  readingFor,
  whoChartFor,
  zScore,
  type Measure,
  type WhoChart,
} from "@/lib/maple/growth";
import type { Baby, Entry } from "@/lib/maple/types";
import { WHO_BOYS } from "@/lib/maple/who-boys";
import { WHO_GIRLS, type WhoTables } from "@/lib/maple/who-girls";

// ── harness ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function eq(actual: unknown, expected: unknown, what = "value") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
}
function ok(cond: unknown, what: string) {
  if (!cond) throw new Error(what);
}
function near(actual: number | null | undefined, expected: number, tol: number, what: string) {
  if (actual == null || !(Math.abs(actual - expected) <= tol)) throw new Error(`${what}: expected ${expected} ± ${tol}, got ${actual}`);
}

// ── WHO reference values ─────────────────────────────────────────────────

/** [day, L, M, S, SD3neg, SD2neg, SD0, SD2, SD3, SD4, P1, P3, P15, P50, P85, P97, P99], kg or cm. */
type Ref = readonly number[];

const WHO_REF: Record<WhoChart, Record<Measure, Ref[]>> = {
  girls: {
    weight: [
      [0, 0.3809, 3.2322, 0.14171, 2.033, 2.395, 3.232, 4.23, 4.793, 5.356, 2.273, 2.44, 2.779, 3.232, 3.729, 4.166, 4.409],
      [7, 0.2671, 3.3388, 0.146, 2.096, 2.464, 3.339, 4.423, 5.052, 5.682, 2.339, 2.51, 2.861, 3.339, 3.873, 4.352, 4.622],
      [14, 0.2304, 3.5693, 0.14339, 2.269, 2.653, 3.569, 4.712, 5.379, 6.047, 2.523, 2.702, 3.068, 3.569, 4.131, 4.637, 4.922],
      [30, 0.1727, 4.1716, 0.13738, 2.72, 3.148, 4.172, 5.456, 6.212, 6.967, 3.003, 3.203, 3.612, 4.172, 4.802, 5.371, 5.694],
      [61, 0.0959, 5.1315, 0.12998, 3.449, 3.944, 5.132, 6.634, 7.525, 8.416, 3.776, 4.007, 4.481, 5.132, 5.866, 6.534, 6.913],
      [91, 0.0407, 5.8393, 0.12622, 3.987, 4.531, 5.839, 7.506, 8.503, 9.499, 4.346, 4.6, 5.121, 5.839, 6.653, 7.395, 7.819],
      [122, -0.0053, 6.428, 0.12401, 4.433, 5.017, 6.428, 8.239, 9.328, 10.418, 4.818, 5.091, 5.653, 6.428, 7.31, 8.118, 8.579],
      [183, -0.0759, 7.3016, 0.12204, 5.088, 5.733, 7.302, 9.341, 10.585, 11.828, 5.514, 5.816, 6.438, 7.302, 8.291, 9.204, 9.729],
      [274, -0.1507, 8.2259, 0.12199, 5.761, 6.473, 8.226, 10.547, 11.986, 13.425, 6.23, 6.565, 7.258, 8.226, 9.346, 10.389, 10.994],
      [365, -0.2022, 8.9462, 0.12267, 6.273, 7.041, 8.946, 11.506, 13.114, 14.721, 6.779, 7.14, 7.891, 8.946, 10.176, 11.331, 12.003],
      [456, -0.2382, 9.5968, 0.12299, 6.738, 7.556, 9.597, 12.366, 14.121, 15.876, 7.276, 7.662, 8.464, 9.597, 10.923, 12.175, 12.907],
      [548, -0.2637, 10.2324, 0.12309, 7.194, 8.061, 10.232, 13.198, 15.091, 16.983, 7.764, 8.173, 9.026, 10.232, 11.65, 12.993, 13.781],
      [639, -0.2814, 10.8521, 0.12335, 7.632, 8.549, 10.852, 14.014, 16.041, 18.068, 8.235, 8.668, 9.571, 10.852, 12.361, 13.795, 14.637],
      [730, -0.294, 11.4741, 0.12389, 8.064, 9.033, 11.474, 14.841, 17.008, 19.175, 8.701, 9.159, 10.115, 11.474, 13.079, 14.607, 15.506],
    ],
    length: [
      [0, 1, 49.1477, 0.0379, 43.56, 45.422, 49.148, 52.873, 54.736, 56.598, 44.814, 45.644, 47.217, 49.148, 51.078, 52.651, 53.481],
      [7, 1, 50.3298, 0.03742, 44.68, 46.563, 50.33, 54.096, 55.98, 57.863, 45.948, 46.788, 48.378, 50.33, 52.282, 53.872, 54.711],
      [14, 1, 51.512, 0.03694, 45.803, 47.706, 51.512, 55.318, 57.221, 59.123, 47.085, 47.933, 49.54, 51.512, 53.484, 55.091, 55.939],
      [30, 1, 53.6326, 0.03641, 47.774, 49.727, 53.633, 57.538, 59.491, 61.444, 49.09, 49.96, 51.609, 53.633, 55.657, 57.305, 58.175],
      [61, 1, 57.0796, 0.03568, 50.97, 53.006, 57.08, 61.153, 63.189, 65.226, 52.342, 53.249, 54.969, 57.08, 59.19, 60.91, 61.817],
      [91, 1, 59.7773, 0.0352, 53.465, 55.569, 59.777, 63.986, 66.09, 68.194, 54.882, 55.82, 57.596, 59.777, 61.958, 63.735, 64.672],
      [122, 1, 62.1071, 0.03486, 55.612, 57.777, 62.107, 66.437, 68.602, 70.767, 57.07, 58.035, 59.863, 62.107, 64.351, 66.179, 67.144],
      [183, 1, 65.751, 0.03448, 58.95, 61.217, 65.751, 70.285, 72.552, 74.819, 60.477, 61.487, 63.401, 65.751, 68.101, 70.015, 71.025],
      [274, 1, 70.1463, 0.03444, 62.899, 65.315, 70.146, 74.978, 77.394, 79.81, 64.526, 65.603, 67.642, 70.146, 72.65, 74.69, 75.766],
      [365, 1, 74.0049, 0.03479, 66.281, 68.856, 74.005, 79.154, 81.729, 84.303, 68.015, 69.163, 71.336, 74.005, 76.673, 78.847, 79.994],
      [456, 1, 77.4893, 0.03534, 69.274, 72.012, 77.489, 82.966, 85.705, 88.443, 71.119, 72.339, 74.651, 77.489, 80.328, 82.64, 83.86],
      [548, 1, 80.7121, 0.03598, 72, 74.904, 80.712, 86.52, 89.424, 92.328, 73.956, 75.25, 77.702, 80.712, 83.722, 86.174, 87.468],
      [639, 1, 83.6595, 0.03665, 74.461, 77.527, 83.66, 89.792, 92.858, 95.924, 76.527, 77.893, 80.482, 83.66, 86.837, 89.426, 90.792],
      [730, 1, 86.4008, 0.03733, 76.725, 79.95, 86.401, 92.851, 96.077, 99.302, 78.898, 80.335, 83.058, 86.401, 89.744, 92.467, 93.904],
    ],
    head: [
      [0, 1, 33.8787, 0.03496, 30.326, 31.51, 33.879, 36.247, 37.432, 38.616, 31.123, 31.651, 32.651, 33.879, 35.106, 36.106, 36.634],
      [7, 1, 34.5529, 0.03374, 31.055, 32.221, 34.553, 36.885, 38.05, 39.216, 31.841, 32.36, 33.345, 34.553, 35.761, 36.746, 37.265],
      [14, 1, 35.2272, 0.03251, 31.791, 32.937, 35.227, 37.518, 38.663, 39.808, 32.563, 33.073, 34.04, 35.227, 36.414, 37.381, 37.891],
      [30, 1, 36.5163, 0.03211, 32.999, 34.171, 36.516, 38.861, 40.034, 41.206, 33.789, 34.311, 35.301, 36.516, 37.732, 38.722, 39.244],
      [61, 1, 38.258, 0.03168, 34.622, 35.834, 38.258, 40.682, 41.894, 43.106, 35.438, 35.978, 37.002, 38.258, 39.514, 40.538, 41.078],
      [91, 1, 39.521, 0.0314, 35.798, 37.039, 39.521, 42.003, 43.244, 44.485, 36.634, 37.187, 38.235, 39.521, 40.807, 41.855, 42.408],
      [122, 1, 40.5895, 0.03119, 36.792, 38.058, 40.59, 43.121, 44.387, 45.653, 37.644, 38.208, 39.277, 40.59, 41.902, 42.971, 43.535],
      [183, 1, 42.2079, 0.03087, 38.299, 39.602, 42.208, 44.814, 46.117, 47.42, 39.177, 39.757, 40.857, 42.208, 43.558, 44.658, 45.239],
      [274, 1, 43.8309, 0.03053, 39.816, 41.155, 43.831, 46.507, 47.845, 49.184, 40.718, 41.314, 42.444, 43.831, 45.218, 46.348, 46.944],
      [365, 1, 44.894, 0.03027, 40.817, 42.176, 44.894, 47.612, 48.971, 50.33, 41.733, 42.338, 43.486, 44.894, 46.302, 47.45, 48.055],
      [456, 1, 45.651, 0.03006, 41.534, 42.906, 45.651, 48.396, 49.768, 51.14, 42.459, 43.07, 44.229, 45.651, 47.073, 48.232, 48.843],
      [548, 1, 46.2431, 0.02987, 42.099, 43.481, 46.243, 49.006, 50.387, 51.768, 43.03, 43.645, 44.811, 46.243, 47.675, 48.841, 49.456],
      [639, 1, 46.7375, 0.02972, 42.57, 43.959, 46.738, 49.516, 50.905, 52.294, 43.506, 44.125, 45.298, 46.738, 48.177, 49.35, 49.969],
      [730, 1, 47.1799, 0.02958, 42.993, 44.389, 47.18, 49.971, 51.367, 52.762, 43.933, 44.555, 45.733, 47.18, 48.626, 49.805, 50.427],
    ],
  },
  boys: {
    weight: [
      [0, 0.3487, 3.3464, 0.14602, 2.08, 2.459, 3.346, 4.419, 5.031, 5.642, 2.331, 2.507, 2.865, 3.346, 3.878, 4.35, 4.613],
      [7, 0.2776, 3.4879, 0.14483, 2.195, 2.579, 3.488, 4.609, 5.257, 5.905, 2.449, 2.628, 2.992, 3.488, 4.04, 4.535, 4.813],
      [14, 0.2581, 3.7529, 0.14142, 2.395, 2.798, 3.753, 4.931, 5.613, 6.296, 2.661, 2.849, 3.232, 3.753, 4.334, 4.854, 5.146],
      [30, 0.2303, 4.4525, 0.13413, 2.919, 3.376, 4.452, 5.776, 6.542, 7.308, 3.221, 3.433, 3.866, 4.453, 5.105, 5.69, 6.018],
      [61, 0.1969, 5.5714, 0.12382, 3.788, 4.322, 5.571, 7.095, 7.974, 8.852, 4.142, 4.39, 4.892, 5.571, 6.324, 6.996, 7.373],
      [91, 0.174, 6.369, 0.11732, 4.429, 5.012, 6.369, 8.016, 8.962, 9.909, 4.815, 5.086, 5.632, 6.369, 7.183, 7.909, 8.315],
      [122, 0.1551, 7.0069, 0.11313, 4.944, 5.565, 7.007, 8.752, 9.754, 10.756, 5.356, 5.644, 6.225, 7.007, 7.87, 8.639, 9.069],
      [183, 0.1256, 7.9389, 0.10957, 5.675, 6.357, 7.939, 9.855, 10.956, 12.057, 6.127, 6.443, 7.081, 7.939, 8.887, 9.73, 10.203],
      [274, 0.0917, 8.9019, 0.10881, 6.391, 7.145, 8.902, 11.042, 12.279, 13.516, 6.891, 7.24, 7.948, 8.902, 9.959, 10.903, 11.433],
      [365, 0.0645, 9.646, 0.10925, 6.926, 7.741, 9.646, 11.983, 13.341, 14.7, 7.465, 7.844, 8.61, 9.646, 10.798, 11.83, 12.412],
      [456, 0.0414, 10.3069, 0.11007, 7.391, 8.262, 10.307, 12.832, 14.308, 15.783, 7.968, 8.372, 9.193, 10.307, 11.549, 12.666, 13.297],
      [548, 0.021, 10.9393, 0.1112, 7.827, 8.753, 10.939, 13.657, 15.253, 16.85, 8.44, 8.871, 9.747, 10.939, 12.274, 13.478, 14.159],
      [639, 0.0029, 11.5474, 0.11261, 8.236, 9.218, 11.547, 14.463, 16.186, 17.908, 8.885, 9.343, 10.275, 11.547, 12.977, 14.27, 15.004],
      [730, -0.0136, 12.1482, 0.11425, 8.63, 9.67, 12.148, 15.272, 17.128, 18.984, 9.317, 9.802, 10.793, 12.148, 13.677, 15.065, 15.854],
    ],
    length: [
      [0, 1, 49.8842, 0.03795, 44.205, 46.098, 49.884, 53.67, 55.564, 57.457, 45.48, 46.324, 47.922, 49.884, 51.846, 53.445, 54.288],
      [7, 1, 51.1152, 0.03723, 45.406, 47.309, 51.115, 54.921, 56.824, 58.727, 46.688, 47.536, 49.143, 51.115, 53.088, 54.694, 55.542],
      [14, 1, 52.3461, 0.03652, 46.611, 48.523, 52.346, 56.169, 58.081, 59.993, 47.899, 48.751, 50.365, 52.346, 54.327, 55.942, 56.793],
      [30, 1, 54.6645, 0.03559, 48.828, 50.773, 54.664, 58.556, 60.501, 62.447, 50.139, 51.005, 52.648, 54.665, 56.681, 58.324, 59.19],
      [61, 1, 58.4384, 0.03423, 52.437, 54.438, 58.438, 62.439, 64.439, 66.44, 53.785, 54.676, 56.365, 58.438, 60.512, 62.201, 63.092],
      [91, 1, 61.4013, 0.03329, 55.269, 57.313, 61.401, 65.489, 67.533, 69.577, 56.646, 57.557, 59.283, 61.401, 63.52, 65.246, 66.156],
      [122, 1, 63.9041, 0.03257, 57.66, 59.741, 63.904, 68.067, 70.148, 72.23, 59.062, 59.989, 61.747, 63.904, 66.061, 67.819, 68.746],
      [183, 1, 67.6435, 0.03165, 61.221, 63.362, 67.644, 71.925, 74.066, 76.207, 62.663, 63.617, 65.425, 67.644, 69.862, 71.67, 72.624],
      [274, 1, 71.9714, 0.03117, 65.241, 67.485, 71.971, 76.458, 78.701, 80.945, 66.753, 67.752, 69.646, 71.971, 74.296, 76.191, 77.19],
      [365, 1, 75.7391, 0.03137, 68.611, 70.987, 75.739, 80.491, 82.867, 85.243, 70.212, 71.27, 73.277, 75.739, 78.202, 80.208, 81.266],
      [456, 1, 79.1258, 0.03196, 71.539, 74.068, 79.126, 84.184, 86.712, 89.241, 73.243, 74.37, 76.505, 79.126, 81.747, 83.882, 85.009],
      [548, 1, 82.2628, 0.03279, 74.171, 76.868, 82.263, 87.658, 90.355, 93.052, 75.988, 77.19, 79.467, 82.263, 85.058, 87.336, 88.538],
      [639, 1, 85.1291, 0.03375, 76.51, 79.383, 85.129, 90.875, 93.748, 96.622, 78.445, 79.725, 82.151, 85.129, 88.107, 90.533, 91.813],
      [730, 1, 87.8018, 0.03479, 78.638, 81.693, 87.802, 93.911, 96.966, 100.02, 80.696, 82.057, 84.636, 87.802, 90.968, 93.547, 94.908],
    ],
    head: [
      [0, 1, 34.4618, 0.03686, 30.651, 31.921, 34.462, 37.002, 38.273, 39.543, 31.507, 32.073, 33.145, 34.462, 35.778, 36.851, 37.417],
      [7, 1, 35.1634, 0.03472, 31.501, 32.722, 35.163, 37.605, 38.826, 40.047, 32.323, 32.867, 33.898, 35.163, 36.429, 37.46, 38.004],
      [14, 1, 35.8649, 0.03258, 32.359, 33.528, 35.865, 38.202, 39.37, 40.539, 33.147, 33.667, 34.654, 35.865, 37.076, 38.063, 38.583],
      [30, 1, 37.2435, 0.03135, 33.741, 34.908, 37.244, 39.579, 40.746, 41.914, 34.527, 35.048, 36.033, 37.244, 38.454, 39.439, 39.96],
      [61, 1, 39.1349, 0.02997, 35.616, 36.789, 39.135, 41.481, 42.654, 43.826, 36.406, 36.929, 37.919, 39.135, 40.351, 41.341, 41.863],
      [91, 1, 40.5008, 0.02918, 36.955, 38.137, 40.501, 42.864, 44.046, 45.228, 37.751, 38.278, 39.276, 40.501, 41.726, 42.724, 43.25],
      [122, 1, 41.6401, 0.02868, 38.057, 39.252, 41.64, 44.029, 45.223, 46.417, 38.862, 39.394, 40.402, 41.64, 42.878, 43.886, 44.418],
      [183, 1, 43.3393, 0.02817, 39.677, 40.898, 43.339, 45.781, 47.002, 48.223, 40.499, 41.043, 42.074, 43.339, 44.605, 45.636, 46.179],
      [274, 1, 45.0007, 0.02792, 41.231, 42.488, 45.001, 47.514, 48.77, 50.026, 42.078, 42.638, 43.699, 45.001, 46.303, 47.364, 47.924],
      [365, 1, 46.0637, 0.02789, 42.21, 43.494, 46.064, 48.633, 49.918, 51.203, 43.075, 43.647, 44.732, 46.064, 47.395, 48.48, 49.052],
      [456, 1, 46.8021, 0.02792, 42.882, 44.189, 46.802, 49.416, 50.722, 52.029, 43.762, 44.344, 45.448, 46.802, 48.156, 49.26, 49.842],
      [548, 1, 47.3718, 0.028, 43.393, 44.719, 47.372, 50.025, 51.351, 52.677, 44.286, 44.877, 45.997, 47.372, 48.747, 49.867, 50.457],
      [639, 1, 47.8399, 0.0281, 43.807, 45.151, 47.84, 50.529, 51.873, 53.217, 44.713, 45.312, 46.447, 47.84, 49.233, 50.368, 50.967],
      [730, 1, 48.2494, 0.02821, 44.166, 45.527, 48.249, 50.972, 52.333, 53.694, 45.083, 45.689, 46.839, 48.249, 49.66, 50.809, 51.416],
    ],
  },
};

/** Sums of L, M and S over days 0-730 of each WHO table: a fingerprint of every row. */
const WHO_SUMS: Record<WhoChart, Record<Measure, [number, number, number]>> = {
  girls: { weight: [-109.9775, 6259.3568, 90.93043], length: [731, 53026.4451, 25.94714], head: [731, 32011.9055, 22.28658] },
  boys: { weight: [58.8684, 6724.5869, 82.78017], length: [731, 54202.0253, 23.89953], head: [731, 32806.3473, 20.80455] },
};

const TABLES: Record<WhoChart, WhoTables> = { girls: WHO_GIRLS, boys: WHO_BOYS };
const CHARTS = ["girls", "boys"] as const;
const MEASURES = ["weight", "length", "head"] as const;
const SD_Z = [-3, -2, 0, 2, 3] as const;
const PCT_COL: Record<(typeof CURVE_PERCENTILES)[number], number> = { 3: 11, 15: 12, 50: 13, 85: 14, 97: 15 };
/** WHO rounds its SD and percentile columns to 3 decimals. */
const ROUNDED = 0.0006;
const stored = (m: Measure, v: number) => (m === "weight" ? v * 1000 : v);

// ── the tables ───────────────────────────────────────────────────────────

for (const chart of CHARTS) {
  for (const m of MEASURES) {
    check(`${chart} ${m}: 731 daily rows, row index is the day, all finite`, () => {
      const rows = TABLES[chart][m].rows;
      eq(rows.length, 731, "rows");
      rows.forEach((r, i) => {
        ok(r[0] === i, `row ${i} is day ${r[0]}`);
        ok(r.every(Number.isFinite) && r[2] > 0 && r[3] > 0, `row ${i} has a bad value`);
      });
    });
    check(`${chart} ${m}: every row matches the WHO table (sums of L, M, S)`, () => {
      const rows = TABLES[chart][m].rows;
      [1, 2, 3].forEach((k, i) => near(rows.reduce((s, r) => s + r[k], 0), WHO_SUMS[chart][m][i], 1e-6, `sum of ${"LMS"[i]}`));
    });
    check(`${chart} ${m}: L, M, S at ${WHO_REF[chart][m].length} reference days are WHO's exactly`, () => {
      for (const r of WHO_REF[chart][m]) eq(TABLES[chart][m].rows[r[0]], r.slice(0, 4), `day ${r[0]}`);
    });
  }
}

// ── the math, against WHO's published values ─────────────────────────────

for (const chart of CHARTS) {
  for (const m of MEASURES) {
    check(`${chart} ${m}: WHO's -3, -2, 0, +2, +3 SD values read back as those z-scores`, () => {
      for (const r of WHO_REF[chart][m]) {
        // WHO's 3-decimal rounding moves z by at most 0.0005 over the narrowest SD step (-3 to -2).
        const tol = 0.0005 / (r[5] - r[4]) + 1e-4;
        SD_Z.forEach((z, i) => near(zScore(m, r[4 + i], r[0], chart), z, tol, `day ${r[0]} SD ${z}`));
      }
    });
    check(`${chart} ${m}: the 3rd, 15th, 50th, 85th and 97th curves are WHO's percentile values`, () => {
      for (const r of WHO_REF[chart][m]) {
        const lines = curves(m, r[0], r[0], 1, chart);
        eq(lines.map((l) => l.p), [...CURVE_PERCENTILES], "curves");
        for (const l of lines) {
          eq(l.points.length, 1, `day ${r[0]} P${l.p} points`);
          near(l.points[0][1], stored(m, r[PCT_COL[l.p]]), stored(m, ROUNDED), `day ${r[0]} P${l.p}`);
        }
      }
    });
    check(`${chart} ${m}: WHO's 1st, 3rd, 50th, 97th and 99th values read back as those percentiles`, () => {
      for (const r of WHO_REF[chart][m]) {
        const at = (col: number) => percentileFor(m, stored(m, r[col]), r[0], chart);
        near(at(10)?.percentile, 1, 0.1, `day ${r[0]} P1`);
        near(at(16)?.percentile, 99, 0.1, `day ${r[0]} P99`);
        eq([at(11)?.label, at(13)?.label, at(15)?.label], ["3rd", "50th", "97th"], `day ${r[0]} labels`);
      }
    });
  }
  check(`${chart} weight: beyond +/-3 SD uses WHO's restricted method; length and head read 4 SD as 4`, () => {
    for (const r of WHO_REF[chart].weight) {
      const [sd3n, sd2n, , sd2, sd3, sd4] = r.slice(4, 10);
      near(zScore("weight", sd4, r[0], chart), 3 + (sd4 - sd3) / (sd3 - sd2), 0.003, `day ${r[0]} SD4`);
      near(zScore("weight", sd3 + 2 * (sd3 - sd2), r[0], chart), 5, 0.003, `day ${r[0]} two SD23 past +3`);
      near(zScore("weight", sd3n - (sd2n - sd3n), r[0], chart), -4, 0.003, `day ${r[0]} one SD23 past -3`);
    }
    for (const m of ["length", "head"] as const) {
      for (const r of WHO_REF[chart][m]) near(zScore(m, r[9], r[0], chart), 4, 0.0005 / (r[5] - r[4]) + 1e-4, `${m} day ${r[0]} SD4`);
    }
  });
}

// ── the baby's sex picks the standard ────────────────────────────────────

check("female reads the girls' standard, male the boys', anything else none", () => {
  eq([whoChartFor("female"), whoChartFor("male"), whoChartFor(null), whoChartFor(undefined)], ["girls", "boys", null, null]);
});

check("no standard: no z-score, no percentile, no curves", () => {
  eq(zScore("weight", 3.4, 10, null), null, "zScore");
  eq(percentileFor("weight", 3400, 10, null), null, "percentileFor");
  eq(curves("weight", 0, 30, 1, null), [], "curves");
});

check("a boy's median birth measurements are the 50th on the boys' standard and not on the girls'", () => {
  for (const m of MEASURES) {
    const median = stored(m, WHO_REF.boys[m][0][2]);
    eq(percentileFor(m, median, 0, "boys")?.label, "50th", `${m} on boys`);
    ok(percentileFor(m, median, 0, "girls")!.percentile > 55, `${m} on girls should read well above the 50th`);
  }
});

check("a reading uses the baby's own standard, and none with no sex set", () => {
  eq(readingFor("weight", 3346.4, 0, "male"), { pct: percentileFor("weight", 3346.4, 0, "boys"), implausible: false }, "boy");
  eq(readingFor("weight", 3346.4, 0, "female"), { pct: percentileFor("weight", 3346.4, 0, "girls"), implausible: false }, "girl");
  eq(readingFor("weight", 3346.4, 0, null), { pct: null, implausible: false }, "no sex");
  eq(readingFor("weight", 6000, 0, "female").implausible, true, "6 kg newborn girl");
  eq(readingFor("weight", 6000, 0, "male").implausible, false, "6 kg newborn boy");
  eq(readingFor("weight", 6000, 0, null).implausible, false, "6 kg newborn, no sex");
  eq(readingFor("weight", 7000, 0, null).implausible, true, "7 kg newborn, no sex");
});

check("with no standard, only a value implausible on both standards is flagged", () => {
  eq(implausibleOnBoth("weight", 7000, 0), true, "7 kg newborn");
  eq(implausibleOnBoth("weight", 3400, 0), false, "3.4 kg newborn");
  eq(percentileFor("weight", 6000, 0, "girls")?.implausible, true, "6 kg newborn on girls");
  eq(percentileFor("weight", 6000, 0, "boys")?.implausible, false, "6 kg newborn on boys");
  eq(implausibleOnBoth("weight", 6000, 0), false, "6 kg newborn with no standard");
});

// ── the growth chart draws the standard it picked ────────────────────────

const BORN = "2026-03-01T10:00:00.000Z";

function fixture(sex: Baby["sex"], name: string, birthWeight: number): Baby {
  return {
    id: 7,
    name,
    nickname: null,
    sex,
    due_date: null,
    born_at: BORN,
    birth_weight_g: birthWeight,
    birth_length_cm: null,
    birth_head_cm: null,
    timezone: "America/Denver",
    settings: {},
  };
}

function weighIn(id: number, day: number, weight_g: number): Entry {
  const at = new Date(Date.parse(BORN) + day * 86_400_000).toISOString();
  return {
    id,
    kind: "growth",
    started_at: at,
    ended_at: null,
    active: false,
    data: { weight_g, at: "doctor" },
    note: null,
    created_by: "parent@example.com",
    source: "app",
    created_at: at,
    updated_at: at,
  } as unknown as Entry;
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

function render(baby: Baby, growth: Entry[]) {
  const html = renderToStaticMarkup(createElement(GrowthChart, { baby, growth, units: "metric", todayKey: "2026-04-01" }));
  return { html, all: text(html), shown: text(html.split("<details")[0]), table: text(html.split("<tbody")[1]?.split("</tbody>")[0] ?? "") };
}

const DAY_14 = 3900;
const percentileCells = (table: string) => [...` ${table} `.matchAll(/ (\d+(?:st|nd|rd|th)|<1st|>99th) /g)].map((m) => m[1]);

check("a girl's chart reads the girls' standard, word for word as before", () => {
  const { all, table } = render(fixture("female", "Wren Example", 3346), [weighIn(1, 14, DAY_14)]);
  ok(
    all.includes(
      "Shaded bands are the WHO growth standards for girls: the wide band spans the 3rd to 97th percentile, the deeper, narrower one the 15th to 85th, and the dashed line is the 50th. Percentiles describe where she sits among healthy girls her age; they aren't targets. Her pediatrician watches the curve over time."
    ),
    "the girls' explanation"
  );
  eq(percentileCells(table), [percentileFor("weight", DAY_14, 14, "girls")!.label, percentileFor("weight", 3346, 0, "girls")!.label], "table");
  ok(!all.includes("boys"), "mentions boys");
});

check("a boy's chart reads the boys' standard", () => {
  const { all, table } = render(fixture("male", "Otis Example", 3346), [weighIn(1, 14, DAY_14)]);
  ok(all.includes("WHO growth standards for boys"), "the boys' standard");
  ok(all.includes("where he sits among healthy boys his age"), "his age");
  ok(all.includes("His pediatrician"), "his pediatrician");
  eq(percentileCells(table), [percentileFor("weight", DAY_14, 14, "boys")!.label, "50th"], "table");
  ok(percentileFor("weight", DAY_14, 14, "boys")!.label !== percentileFor("weight", DAY_14, 14, "girls")!.label, "the fixture should tell the standards apart");
  ok(!all.includes("girls"), "mentions girls");
});

check("with no sex set, the chart says why there are no percentiles and shows none", () => {
  const { all, shown, table } = render(fixture(null, "Sky Example", 3346), [weighIn(1, 14, DAY_14)]);
  ok(shown.includes("WHO's growth standards are separate for girls and boys. Sky's sex isn't set, so this shows the measurements without percentiles."), "visible note");
  ok(table.includes("3.35 kg") || table.includes("3,346"), `the birth weight row: ${table}`);
  eq(percentileCells(table), [], "percentile cells");
  ok(!all.includes("Shaded bands"), "explains bands that aren't drawn");
  ok(all.includes("Sky's pediatrician"), "the name for a pronoun");
});

check("with no sex set, a value off both standards still asks for a double-check", () => {
  eq((render(fixture(null, "Sky Example", 7000), []).all.match(/Double-check/g) ?? []).length, 1, "7 kg at birth");
  eq((render(fixture(null, "Sky Example", 6000), []).all.match(/Double-check/g) ?? []).length, 0, "6 kg at birth");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
