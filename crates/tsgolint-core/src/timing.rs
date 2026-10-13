//! Per-rule timings for `-debug timings` (Go `internal/linter/timing.go`).

use std::time::Duration;

use rustc_hash::FxHashMap;

/// The total time and call count of one rule.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuleTimingRecord {
    pub rule_name: String,
    /// Nanoseconds.
    pub duration: u64,
    /// One for each `create` call plus one for each listener call.
    pub calls: u64,
}

/// Rule timings by rule name, merged over files, checkers and programs.
#[derive(Clone, Debug, Default)]
pub struct RuleTimings {
    by_rule: FxHashMap<String, (u64, u64)>,
}

impl RuleTimings {
    pub fn add(&mut self, rule_name: &str, duration_nanos: u64, calls: u64) {
        match self.by_rule.get_mut(rule_name) {
            Some(entry) => {
                entry.0 += duration_nanos;
                entry.1 += calls;
            }
            None => {
                self.by_rule
                    .insert(rule_name.to_owned(), (duration_nanos, calls));
            }
        }
    }

    pub fn merge(&mut self, other: RuleTimings) {
        for (rule_name, (duration, calls)) in other.by_rule {
            self.add(&rule_name, duration, calls);
        }
    }

    pub fn is_empty(&self) -> bool {
        self.by_rule.is_empty()
    }

    /// The records, slowest first, then by name.
    pub fn records(&self) -> Vec<RuleTimingRecord> {
        let mut records: Vec<_> = self
            .by_rule
            .iter()
            .map(|(rule_name, &(duration, calls))| RuleTimingRecord {
                rule_name: rule_name.clone(),
                duration,
                calls,
            })
            .collect();
        records.sort_by(|a, b| {
            b.duration
                .cmp(&a.duration)
                .then_with(|| a.rule_name.cmp(&b.rule_name))
        });
        records
    }
}

/// The time and calls of each rule of one file, by rule index.
#[derive(Default)]
pub(crate) struct FileTimings {
    stats: Vec<(Duration, u64)>,
}

impl FileTimings {
    pub(crate) fn reset(&mut self, rules: usize) {
        self.stats.clear();
        self.stats.resize(rules, (Duration::ZERO, 0));
    }

    #[inline]
    pub(crate) fn record(&mut self, rule: usize, elapsed: Duration) {
        let stat = &mut self.stats[rule];
        stat.0 += elapsed;
        stat.1 += 1;
    }

    /// Adds this file's stats to `into` by rule name.
    pub(crate) fn merge_into<'a>(
        &self,
        names: impl Iterator<Item = &'a str>,
        into: &mut RuleTimings,
    ) {
        for (name, &(duration, calls)) in names.zip(&self.stats) {
            if calls > 0 {
                into.add(
                    name,
                    u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX),
                    calls,
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_and_sorts() {
        let mut t = RuleTimings::default();
        t.add("b", 10, 1);
        t.add("a", 10, 2);
        let mut other = RuleTimings::default();
        other.add("c", 30, 1);
        other.add("b", 5, 3);
        t.merge(other);
        let records: Vec<_> = t
            .records()
            .into_iter()
            .map(|r| (r.rule_name, r.duration, r.calls))
            .collect();
        assert_eq!(
            records,
            [
                ("c".into(), 30, 1),
                ("b".into(), 15, 4),
                ("a".into(), 10, 2)
            ]
        );
    }
}
