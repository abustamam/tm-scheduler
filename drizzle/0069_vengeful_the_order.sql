ALTER TABLE "clubs" ADD CONSTRAINT "clubs_table_topics_window_check" CHECK ((
				("clubs"."table_topics_min_seconds" IS NULL) = ("clubs"."table_topics_max_seconds" IS NULL)
				AND (
					"clubs"."table_topics_max_seconds" IS NULL
					OR (
						"clubs"."table_topics_min_seconds" >= 0
						AND "clubs"."table_topics_max_seconds" > "clubs"."table_topics_min_seconds"
						AND "clubs"."table_topics_max_seconds" <= 600
					)
				)
			));