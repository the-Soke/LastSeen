module.exports = {
  id: '001_initial_schema',
  description: 'Create initial LastSeen schema',
  up: async ({ sequelize }) => {
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS cases (
        id              CHAR(36)         NOT NULL DEFAULT (UUID()),
        case_number     VARCHAR(20)      NOT NULL,
        status          ENUM('active','found','closed') NOT NULL DEFAULT 'active',
        urgency_level   TINYINT UNSIGNED NOT NULL DEFAULT 10,
        opened_at       DATETIME         NOT NULL DEFAULT NOW(),
        resolved_at     DATETIME             NULL,
        closed_at       DATETIME             NULL,
        scheduled_purge DATETIME             NULL,
        created_by      CHAR(36)         NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_case_number (case_number),
        INDEX idx_status_urgency (status, urgency_level),
        INDEX idx_opened_at      (opened_at),
        INDEX idx_scheduled_purge(scheduled_purge)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

      CREATE TABLE IF NOT EXISTS missing_persons (
        id              CHAR(36)         NOT NULL DEFAULT (UUID()),
        case_id         CHAR(36)         NOT NULL,
        full_name       VARCHAR(120)     NOT NULL,
        nickname        VARCHAR(60)          NULL,
        date_of_birth   DATE                 NULL,
        age_at_report   TINYINT UNSIGNED     NULL,
        gender          ENUM('male','female','other','unknown') NOT NULL DEFAULT 'unknown',
        height_cm       SMALLINT UNSIGNED    NULL,
        weight_kg       SMALLINT UNSIGNED    NULL,
        skin_tone       ENUM('very_light','light','medium','dark','very_dark') NULL,
        hair_color      VARCHAR(40)          NULL,
        hair_style      VARCHAR(60)          NULL,
        eye_color       VARCHAR(40)          NULL,
        distinguishing  TEXT                 NULL,
        clothing_desc   TEXT                 NOT NULL,
        last_seen_at    DATETIME         NOT NULL,
        last_seen_lat   DECIMAL(9,6)     NOT NULL,
        last_seen_lng   DECIMAL(9,6)     NOT NULL,
        last_seen_place VARCHAR(200)         NULL,
        last_seen_notes TEXT                 NULL,
        photo_url       VARCHAR(500)         NULL,
        photo_hash      CHAR(64)             NULL,
        created_at      DATETIME         NOT NULL DEFAULT NOW(),
        PRIMARY KEY (id),
        CONSTRAINT fk_mp_case FOREIGN KEY (case_id)
          REFERENCES cases(id) ON DELETE CASCADE ON UPDATE CASCADE,
        INDEX idx_mp_case  (case_id),
        INDEX idx_mp_geo   (last_seen_lat, last_seen_lng)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

      CREATE TABLE IF NOT EXISTS users (
        id                   CHAR(36)         NOT NULL DEFAULT (UUID()),
        role                 ENUM('guardian','coordinator','admin','witness') NOT NULL,
        display_name         VARCHAR(100)         NULL,
        phone_hash           CHAR(64)             NULL,
        push_token           VARCHAR(300)         NULL,
        locale               VARCHAR(10)      NOT NULL DEFAULT 'en',
        preferred_radius_km  SMALLINT UNSIGNED NOT NULL DEFAULT 10,
        last_known_lat       DECIMAL(9,6)         NULL,
        last_known_lng       DECIMAL(9,6)         NULL,
        location_updated_at  DATETIME             NULL,
        is_active            TINYINT(1)       NOT NULL DEFAULT 1,
        created_at           DATETIME         NOT NULL DEFAULT NOW(),
        PRIMARY KEY (id),
        INDEX idx_user_location (last_known_lat, last_known_lng),
        INDEX idx_user_role     (role, is_active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

      CREATE TABLE IF NOT EXISTS witness_alerts (
        id                   CHAR(36)         NOT NULL DEFAULT (UUID()),
        case_id              CHAR(36)         NOT NULL,
        user_id              CHAR(36)         NOT NULL,
        alert_lat            DECIMAL(9,6)     NOT NULL,
        alert_lng            DECIMAL(9,6)     NOT NULL,
        radius_km            DECIMAL(5,2)     NOT NULL,
        channel              ENUM('push','sms','both') NOT NULL DEFAULT 'push',
        sent_at              DATETIME             NULL,
        delivered_at         DATETIME             NULL,
        opened_at            DATETIME             NULL,
        ai_relevance_score   DECIMAL(4,3)     NOT NULL DEFAULT 0.000,
        targeting_reason     VARCHAR(200)         NULL,
        status               ENUM('pending','sent','seen','responded','dismissed') NOT NULL DEFAULT 'pending',
        response_at          DATETIME             NULL,
        created_at           DATETIME         NOT NULL DEFAULT NOW(),
        PRIMARY KEY (id),
        CONSTRAINT fk_wa_case FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE,
        CONSTRAINT fk_wa_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_wa_case_status (case_id, status),
        INDEX idx_wa_user        (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

      CREATE TABLE IF NOT EXISTS anonymous_tips (
        id               CHAR(36)     NOT NULL DEFAULT (UUID()),
        case_id          CHAR(36)     NOT NULL,
        submitter_token  CHAR(64)     NOT NULL,
        sighting_at      DATETIME     NOT NULL,
        sighting_lat     DECIMAL(9,6) NOT NULL,
        sighting_lng     DECIMAL(9,6) NOT NULL,
        sighting_place   VARCHAR(200)     NULL,
        description      TEXT         NOT NULL,
        confidence       ENUM('certain','likely','unsure') NOT NULL DEFAULT 'unsure',
        photo_url        VARCHAR(500)     NULL,
        review_status    ENUM('pending','verified','rejected','escalated') NOT NULL DEFAULT 'pending',
        reviewed_by      CHAR(36)         NULL,
        reviewed_at      DATETIME         NULL,
        review_notes     TEXT             NULL,
        created_at       DATETIME     NOT NULL DEFAULT NOW(),
        PRIMARY KEY (id),
        CONSTRAINT fk_tip_case FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE,
        CONSTRAINT fk_tip_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_tip_case_status (case_id, review_status),
        INDEX idx_tip_geo         (sighting_lat, sighting_lng),
        INDEX idx_tip_token       (submitter_token)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

      CREATE TABLE IF NOT EXISTS ai_facial_scores (
        id                   CHAR(36)      NOT NULL DEFAULT (UUID()),
        case_id              CHAR(36)      NOT NULL,
        source_type          ENUM('tip_photo','new_upload','system') NOT NULL,
        source_ref_id        CHAR(36)          NULL,
        source_photo_hash    CHAR(64)      NOT NULL,
        similarity_score     DECIMAL(5,4)  NOT NULL,
        model_version        VARCHAR(40)   NOT NULL,
        computed_at          DATETIME      NOT NULL DEFAULT NOW(),
        requires_review      TINYINT(1)    NOT NULL DEFAULT 1,
        verified_by          CHAR(36)          NULL,
        verified_at          DATETIME          NULL,
        verification_outcome ENUM('confirmed_match','rejected','inconclusive') NULL,
        verification_notes   TEXT              NULL,
        PRIMARY KEY (id),
        CONSTRAINT fk_afs_case FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE,
        CONSTRAINT fk_afs_verifier FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_afs_case_score (case_id, similarity_score DESC)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

      CREATE TABLE IF NOT EXISTS ai_memory_matches (
        id               CHAR(36)      NOT NULL DEFAULT (UUID()),
        case_id          CHAR(36)      NOT NULL,
        tip_id           CHAR(36)          NULL,
        parsed_age       TINYINT UNSIGNED  NULL,
        parsed_gender    ENUM('male','female','other','unknown') NULL,
        parsed_skin_tone VARCHAR(30)       NULL,
        parsed_hair      VARCHAR(80)       NULL,
        parsed_clothing  TEXT              NULL,
        parsed_location  VARCHAR(200)      NULL,
        raw_description  TEXT          NOT NULL,
        match_score      DECIMAL(5,4)  NOT NULL,
        matched_fields   JSON          NOT NULL,
        model_version    VARCHAR(40)   NOT NULL,
        computed_at      DATETIME      NOT NULL DEFAULT NOW(),
        requires_review  TINYINT(1)    NOT NULL DEFAULT 1,
        reviewed_by      CHAR(36)          NULL,
        reviewed_at      DATETIME          NULL,
        review_outcome   ENUM('useful','misleading','inconclusive') NULL,
        PRIMARY KEY (id),
        CONSTRAINT fk_amm_case FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE,
        CONSTRAINT fk_amm_tip  FOREIGN KEY (tip_id)  REFERENCES anonymous_tips(id) ON DELETE SET NULL,
        INDEX idx_amm_case_score (case_id, match_score DESC)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

      CREATE TABLE IF NOT EXISTS case_activity_log (
        id          BIGINT UNSIGNED AUTO_INCREMENT NOT NULL,
        case_id     CHAR(36)     NOT NULL,
        actor_id    CHAR(36)         NULL,
        action      VARCHAR(80)  NOT NULL,
        payload     JSON             NULL,
        ip_hash     CHAR(64)         NULL,
        occurred_at DATETIME     NOT NULL DEFAULT NOW(),
        PRIMARY KEY (id),
        CONSTRAINT fk_cal_case FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE,
        INDEX idx_cal_case_time (case_id, occurred_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id         CHAR(36)     NOT NULL DEFAULT (UUID()),
        user_id    CHAR(36)     NOT NULL,
        endpoint   VARCHAR(500) NOT NULL,
        p256dh_key TEXT         NOT NULL,
        auth_key   TEXT         NOT NULL,
        created_at DATETIME     NOT NULL DEFAULT NOW(),
        PRIMARY KEY (id),
        UNIQUE KEY uq_ps_user (user_id),
        CONSTRAINT fk_ps_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

      CREATE TABLE IF NOT EXISTS notification_log (
        id              BIGINT UNSIGNED AUTO_INCREMENT NOT NULL,
        alert_id        CHAR(36)         NULL,
        user_id         CHAR(36)     NOT NULL,
        type            ENUM('alert','case_update','tip_ack','system') NOT NULL,
        channel         ENUM('push','sms') NOT NULL,
        payload_summary VARCHAR(200)     NULL,
        sent_at         DATETIME     NOT NULL DEFAULT NOW(),
        status          ENUM('sent','failed','bounced') NOT NULL DEFAULT 'sent',
        PRIMARY KEY (id),
        INDEX idx_nl_user    (user_id),
        INDEX idx_nl_alert   (alert_id),
        INDEX idx_nl_sent_at (sent_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
  },
};

