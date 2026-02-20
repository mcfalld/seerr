import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPerformanceIndexes1770627987304 implements MigrationInterface {
  name = 'AddPerformanceIndexes1770627987304';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_user_settings_maxMovieRating" ON "user_settings" ("maxMovieRating")`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_user_settings_maxTvRating" ON "user_settings" ("maxTvRating")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_user_settings_maxTvRating"`
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_user_settings_maxMovieRating"`
    );
  }
}
