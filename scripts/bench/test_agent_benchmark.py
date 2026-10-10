import unittest
from agent_benchmark_measure import output_hash, summarize


class MeasurementTests(unittest.TestCase):
    def test_ranked_results_preserve_order(self):
        rows = [{"rank": 1, "cost": 0.5}, {"rank": 2, "cost": 0.25}]
        self.assertNotEqual(
            output_hash("agent_sessions_browser", rows),
            output_hash("agent_sessions_browser", rows[::-1]),
        )
        self.assertEqual(
            output_hash("agent_priced_usage", rows),
            output_hash("agent_priced_usage", rows[::-1]),
        )
        self.assertNotEqual(
            output_hash("agent_priced_usage", rows),
            output_hash("agent_priced_usage", rows + rows[:1]),
        )

    def test_parity_compares_values_without_float_tolerance(self):
        self.assertNotEqual(
            output_hash("agent_usage_summary", [{"cost": 0.123456}]),
            output_hash("agent_usage_summary", [{"cost": 0.123457}]),
        )
        self.assertEqual(
            output_hash("agent_usage_summary", [{"a": 1, "b": 2}]),
            output_hash("agent_usage_summary", [{"b": 2, "a": 1}]),
        )

    def test_ten_run_tail_is_maximum_and_even_median_is_average(self):
        samples = [
            {"wall_ms": n, "db_ms": n / 2, "rows_read": 100 - n, "bytes_read": 1000 + n}
            for n in range(1, 11)
        ]
        result = summarize(samples)
        self.assertEqual(
            result,
            {
                "median_ms": 5.5,
                "p95_ms": 10,
                "median_db_ms": 2.75,
                "rows_read": 99,
                "bytes_read": 1010,
            },
        )


if __name__ == "__main__":
    unittest.main()
