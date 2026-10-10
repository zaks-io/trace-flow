import unittest
from pathlib import Path
import tempfile
from agent_benchmark_measure import measure
from agent_benchmark_queries import write_variants, endpoint_inventory, LIFETIME
from agent_benchmark_measure import output_hash, summarize
from agent_benchmark_evidence import boundary_evidence


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


class RunnerContractTests(unittest.TestCase):
    def test_no_deployable_benchmark_resources_at_any_depth(self):
        bench = Path(__file__).resolve().parent
        resources = list(bench.rglob("*.pipe")) + list(bench.rglob("*.datasource"))
        self.assertEqual(
            resources, [], "Generate Tinybird resources in a temporary project"
        )
        with self.assertRaises(ValueError):
            write_variants(bench.parents[1], bench, [])

    def test_future_facts_fail_before_measurement(self):
        class Client:
            def rows(self, sql):
                return [{"end_day_rows": 1, "after_end_rows": 1, "future_rows": 1}]

        with self.assertRaisesRegex(RuntimeError, "future events"):
            boundary_evidence(
                Client(),
                {"agent_message_fact_versions": "synthetic_messages"},
                1791598920000,
            )

    def test_inventory_and_all_parameter_sets_are_measured(self):
        root = Path(__file__).resolve().parents[2]
        endpoints = endpoint_inventory(root)
        self.assertEqual(len(endpoints), 18)

        class Client:
            def pipe_data(self, path, params):
                return {
                    "statistics": {"elapsed": 0.01, "rows_read": 10, "bytes_read": 100},
                    "data": [{"synthetic_cost": 1}],
                }

        with tempfile.TemporaryDirectory() as private:
            records = measure(
                Client(), endpoints, 1791598920000, 10, Path(private) / "out.json"
            )
        self.assertEqual(len(records), 54)
        self.assertEqual(
            {(r["days"], r["retention_days"]) for r in records},
            {(7, 7), (7, 30), (30, 30)},
        )
        for record in records:
            self.assertTrue(record["passed"])
            self.assertEqual(len(record["samples"]["direct"]), 10)
            self.assertEqual(
                record["parity_examples"]["current"], [{"synthetic_cost": 1}]
            )
            self.assertEqual("two_stage" in record, record["endpoint"] in LIFETIME)


if __name__ == "__main__":
    unittest.main()
