import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ScrapingService, FBrefTeamData } from '../scraping/scraping.service';
import { PrismaService } from 'prisma/prisma.service';
import { FIFA_RANKINGS, WC2026_GROUPS } from 'src/utils/wc2026-groups';

@Injectable()
export class TeamsService {
  private readonly logger = new Logger(TeamsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scrapingService: ScrapingService,
  ) {}

  // ─── SEED ────────────────────────────────────────────────────────────────

  async seedAllTeams(): Promise<number> {
    let count = 0;

    for (const [group, teams] of Object.entries(WC2026_GROUPS)) {
      for (const team of teams) {
        await this.prisma.nationalTeam.upsert({
          where: { fbrefId: team.fbrefId },
          create: {
            fbrefId: team.fbrefId,
            name: team.name,
            country: team.country,
            flagCode: team.flagCode,
            fifaRanking: FIFA_RANKINGS[team.name] ?? null,
            group,
            fbrefUrl: team.fbrefUrl,
          },
          update: {
            fifaRanking: FIFA_RANKINGS[team.name] ?? null,
            group,
            fbrefUrl: team.fbrefUrl,
          },
        });
        count++;
      }
    }

    this.logger.log(`✅ Seeded ${count} teams`);
    return count;
  }

  findAll() {
    return this.prisma.nationalTeam.findMany({
      include: { teamStats: true },
      orderBy: [{ group: 'asc' }, { name: 'asc' }],
    });
  }

  findByGroup(group: string) {
    return this.prisma.nationalTeam.findMany({
      where: { group: group.toUpperCase() },
      include: {
        teamStats: { orderBy: { createdAt: 'desc' }, take: 1 },
        players: {
          include: { playerStats: { orderBy: { createdAt: 'desc' }, take: 1 } },
        },
      },
    });
  }

  findByFbrefId(fbrefId: string) {
    return this.prisma.nationalTeam.findUnique({
      where: { fbrefId },
      include: {
        teamStats: true,
        players: { include: { playerStats: true } },
      },
    });
  }

  async findById(id: string) {
    const team = await this.prisma.nationalTeam.findUnique({
      where: { id },
      include: {
        teamStats: { orderBy: { createdAt: 'desc' } },
        players: {
          include: {
            playerStats: { orderBy: { createdAt: 'desc' }, take: 1 },
          },
          orderBy: { name: 'asc' },
        },
        matchesHome: { include: { awayTeam: true } },
        matchesAway: { include: { homeTeam: true } },
      },
    });

    if (!team) throw new NotFoundException(`Team ${id} not found`);
    return team;
  }

  // ─── PERSIST SCRAPED DATA ─────────────────────────────────────────────────

  async persistScrapedData(teamId: string, data: FBrefTeamData): Promise<void> {
    const { teamStats, players, recentMatches } = data;

    // Upsert TeamStats
    if (teamStats) {
      await this.prisma.teamStats.upsert({
        where: {
          teamId_competition_season: {
            teamId,
            competition: teamStats.competition,
            season: teamStats.season,
          },
        },
        create: {
          teamId,
          competition: teamStats.competition,
          season: teamStats.season,
          matchesPlayed: teamStats.matchesPlayed,
          wins: teamStats.wins,
          draws: teamStats.draws,
          losses: teamStats.losses,
          goalsFor: teamStats.goalsFor,
          goalsAgainst: teamStats.goalsAgainst,
          goalDiff: teamStats.goalDiff,
          cleanSheets: teamStats.cleanSheets,
          avgGoalsFor: teamStats.avgGoalsFor,
          avgGoalsAgainst: teamStats.avgGoalsAgainst,
          form: teamStats.form,
        },
        update: {
          matchesPlayed: teamStats.matchesPlayed,
          wins: teamStats.wins,
          draws: teamStats.draws,
          losses: teamStats.losses,
          goalsFor: teamStats.goalsFor,
          goalsAgainst: teamStats.goalsAgainst,
          goalDiff: teamStats.goalDiff,
          cleanSheets: teamStats.cleanSheets,
          avgGoalsFor: teamStats.avgGoalsFor,
          avgGoalsAgainst: teamStats.avgGoalsAgainst,
          form: teamStats.form,
        },
      });
    }

    // Upsert Players & PlayerStats
    for (const p of players) {
      const player = await this.prisma.player.upsert({
        where: { fbrefId: p.fbrefId },
        create: {
          fbrefId: p.fbrefId,
          name: p.name,
          position: p.position || null,
          age: p.age || null,
          teamId,
        },
        update: {
          name: p.name,
          position: p.position || null,
          age: p.age || null,
        },
      });

      await this.prisma.playerStats.deleteMany({
        where: { playerId: player.id },
      });

      await this.prisma.playerStats.create({
        data: {
          playerId: player.id,
          competition: 'International Friendlies',
          season: '2026',
          matchesPlayed: p.matchesPlayed,
          starts: p.starts,
          minutes: p.minutes,
          goals: p.goals,
          assists: p.assists,
          goalsAssists: p.goals + p.assists,
          yellowCards: p.yellowCards,
          redCards: p.redCards,
          goalsPer90: p.goalsPer90 || null,
          assistsPer90: p.assistsPer90 || null,
        },
      });
    }

    // Persist recent matches (unique by date + opponent + competition)
    for (const m of recentMatches) {
      if (!m.date) continue;
      const matchId =
        `${teamId}-${m.date}-${m.opponent.replace(/\s/g, '')}-${m.competition}`.slice(
          0,
          60,
        );

      // Find opponent team if exists
      const opponentTeam = await this.prisma.nationalTeam.findFirst({
        where: { name: { contains: m.opponent, mode: 'insensitive' } },
      });

      const isHome = m.venue === 'Home';
      const matchDate = new Date(m.date);

      if (isNaN(matchDate.getTime())) continue;

      await this.prisma.match.upsert({
        where: { id: matchId },
        create: {
          id: matchId,
          homeTeamId: isHome ? teamId : (opponentTeam?.id ?? teamId),
          awayTeamId: isHome ? (opponentTeam?.id ?? teamId) : teamId,
          competition: m.competition,
          round: m.round || null,
          matchDate,
          venue: m.venue || null,
          homeScore: isHome ? m.goalsFor : m.goalsAgainst,
          awayScore: isHome ? m.goalsAgainst : m.goalsFor,
          result: m.result || null,
          formation: m.formation || null,
          oppFormation: m.oppFormation || null,
          attendance: m.attendance || null,
        },
        update: {
          homeScore: isHome ? m.goalsFor : m.goalsAgainst,
          awayScore: isHome ? m.goalsAgainst : m.goalsFor,
          result: m.result || null,
          formation: m.formation || null,
          oppFormation: m.oppFormation || null,
        },
      });
    }

    this.logger.log(
      `💾 Persisted data for team ${teamId}: ${players.length} players, ${recentMatches.length} matches`,
    );
  }

  // ─── BULK OPERATIONS ─────────────────────────────────────────────────────

  async scrapeAndPersistGroup(group: string): Promise<any[]> {
    const teams = await this.prisma.nationalTeam.findMany({
      where: { group },
    });

    const results: any[] = [];
    for (const team of teams) {
      try {
        const data = await this.scrapingService.scrapeTeam(
          team.fbrefId,
          team.fbrefUrl,
        );
        await this.persistScrapedData(team.id, data);
        results.push({
          team: team.name,
          success: true,
          players: data.players.length,
          matches: data.recentMatches.length,
        });
      } catch (err: any) {
        results.push({ team: team.name, success: false, error: err?.message });
      }
    }
    return results;
  }

  async scrapeAllTeams(groups?: string[]): Promise<void> {
    const where = groups ? { group: { in: groups } } : {};
    const teams = await this.prisma.nationalTeam.findMany({ where });

    this.logger.log(`🚀 Starting scrape of ${teams.length} teams...`);
    let done = 0;

    for (const team of teams) {
      try {
        const data = await this.scrapingService.scrapeTeam(
          team.fbrefId,
          team.fbrefUrl,
        );
        await this.persistScrapedData(team.id, data);
        done++;
        this.logger.log(`✅ [${done}/${teams.length}] ${team.name}`);
      } catch (err: any) {
        this.logger.error(`❌ Failed ${team.name}: ${err?.message}`);
      }
    }

    this.logger.log(`🏁 Scraping complete: ${done}/${teams.length} teams`);
  }

  // ─── STATS ────────────────────────────────────────────────────────────────

  async getTeamFullStats(fbrefId: string) {
    const team = await this.prisma.nationalTeam.findUnique({
      where: { fbrefId },
      include: {
        teamStats: { orderBy: { createdAt: 'desc' } },
        players: {
          include: {
            playerStats: { orderBy: { minutes: 'desc' } },
          },
          orderBy: { name: 'asc' },
        },
        matchesHome: {
          include: { awayTeam: { select: { name: true, flagCode: true } } },
          orderBy: { matchDate: 'desc' },
          take: 10,
        },
        matchesAway: {
          include: { homeTeam: { select: { name: true, flagCode: true } } },
          orderBy: { matchDate: 'desc' },
          take: 10,
        },
      },
    });

    if (!team) throw new NotFoundException(`Team ${fbrefId} not found`);

    // Compute aggregates
    const latestStats = team.teamStats[0];
    const topScorers = team.players
      .flatMap((p) => p.playerStats.map((s) => ({ name: p.name, ...s })))
      .sort((a, b) => b.goals - a.goals)
      .slice(0, 5);

    return { team, latestStats, topScorers };
  }

  getScrapingLogs(limit = 50) {
    return this.prisma.scrapingLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async getGroupStandings() {
    const groups: Record<string, any[]> = {};

    for (const g of 'ABCDEFGHIJKL'.split('')) {
      const teams = await this.prisma.nationalTeam.findMany({
        where: { group: g },
        include: { teamStats: { orderBy: { createdAt: 'desc' }, take: 1 } },
      });

      groups[g] = teams.map((t) => ({
        id: t.id,
        fbrefId: t.fbrefId,
        name: t.name,
        flagCode: t.flagCode,
        fifaRanking: t.fifaRanking,
        stats: t.teamStats[0] || null,
      }));
    }

    return groups;
  }

  // teams.service.ts

  /**
   * Detailed comparison between two national teams.
   * Returns enhanced statistics and head-to-head history for analysis.
   */
  async getConfrontacion(fbrefId1: string, fbrefId2: string) {
    this.logger.log(
      `[Confrontation] Fetching data for ${fbrefId1} vs ${fbrefId2}`,
    );

    const team1 = await this.getTeamFullStats(fbrefId1);
    const team2 = await this.getTeamFullStats(fbrefId2);

    this.logger.log(
      `[Confrontation] Team1: ${team1.team.name} (Rank ${team1.team.fifaRanking})`,
    );
    this.logger.log(
      `[Confrontation] Team2: ${team2.team.name} (Rank ${team2.team.fifaRanking})`,
    );

    // Head-to-head history
    const headToHead = await this.prisma.match.findMany({
      where: {
        OR: [
          { homeTeamId: team1.team.id, awayTeamId: team2.team.id },
          { homeTeamId: team2.team.id, awayTeamId: team1.team.id },
        ],
      },
      include: {
        homeTeam: true,
        awayTeam: true,
      },
      orderBy: { matchDate: 'desc' },
    });

    this.logger.log(
      `[Confrontation] Found ${headToHead.length} previous matches`,
    );

    // Calculate head-to-head stats
    let team1Wins = 0,
      team2Wins = 0,
      draws = 0;
    for (const match of headToHead) {
      const isTeam1Home = match.homeTeamId === team1.team.id;
      const team1Score = isTeam1Home ? match.homeScore : match.awayScore;
      const team2Score = isTeam1Home ? match.awayScore : match.homeScore;
      if (!team1Score || !team2Score) continue; // skip if scores are missing
      if (team1Score > team2Score) team1Wins++;
      else if (team2Score > team1Score) team2Wins++;
      else draws++;
    }

    const h2hSummary = headToHead.map((match) => ({
      date: match.matchDate.toISOString().split('T')[0],
      result: match.result,
      home: match.homeTeam.name,
      away: match.awayTeam.name,
      homeScore: match.homeScore,
      awayScore: match.awayScore,
      venue: match.venue,
      competition: match.competition,
    }));

    // Recent form breakdown (last 5 matches)
    const getFormBreakdown = (teamStats: any) => {
      const formStr = teamStats?.form || '';
      const formArray = formStr.split('').slice(-5);
      return formArray.map((result, idx) => ({
        match: idx + 1,
        result: result === 'W' ? 'Win' : result === 'D' ? 'Draw' : 'Loss',
      }));
    };

    // Simple probability model (Elo-based plus goals)
    const rankDiff =
      (team2.team.fifaRanking || 100) - (team1.team.fifaRanking || 100);
    const baseProb = 0.5 + rankDiff / 300; // normalized
    const probTeam1 = Math.min(0.75, Math.max(0.25, baseProb));
    const probTeam2 = Math.min(0.75, Math.max(0.25, 1 - baseProb));
    const probDraw = 1 - probTeam1 - probTeam2;

    const response = {
      timestamp: new Date().toISOString(),
      team1: {
        id: team1.team.fbrefId,
        name: team1.team.name,
        fifaRanking: team1.team.fifaRanking,
        avgGoalsScored: team1.latestStats?.avgGoalsFor,
        avgGoalsConceded: team1.latestStats?.avgGoalsAgainst,
        recentForm: team1.latestStats?.form,
        recentFormBreakdown: getFormBreakdown(team1.latestStats),
        topScorers: team1.topScorers.map((s) => ({
          name: s.name,
          goals: s.goals,
          goalsPer90: s.goalsPer90,
        })),
        matchesPlayed: team1.latestStats?.matchesPlayed,
        wins: team1.latestStats?.wins,
        draws: team1.latestStats?.draws,
        losses: team1.latestStats?.losses,
      },
      team2: {
        id: team2.team.fbrefId,
        name: team2.team.name,
        fifaRanking: team2.team.fifaRanking,
        avgGoalsScored: team2.latestStats?.avgGoalsFor,
        avgGoalsConceded: team2.latestStats?.avgGoalsAgainst,
        recentForm: team2.latestStats?.form,
        recentFormBreakdown: getFormBreakdown(team2.latestStats),
        topScorers: team2.topScorers.map((s) => ({
          name: s.name,
          goals: s.goals,
          goalsPer90: s.goalsPer90,
        })),
        matchesPlayed: team2.latestStats?.matchesPlayed,
        wins: team2.latestStats?.wins,
        draws: team2.latestStats?.draws,
        losses: team2.latestStats?.losses,
      },
      headToHead: {
        totalMatches: headToHead.length,
        team1Wins,
        team2Wins,
        draws,
        matches: h2hSummary,
      },
      simulation: {
        winProbability: {
          [team1.team.name]: parseFloat(probTeam1.toFixed(3)),
          [team2.team.name]: parseFloat(probTeam2.toFixed(3)),
          draw: parseFloat(probDraw.toFixed(3)),
        },
        expectedGoals: {
          [team1.team.name]: team1.latestStats?.avgGoalsFor || 1,
          [team2.team.name]: team2.latestStats?.avgGoalsFor || 1,
        },
        method: 'Elo + Goals average (simplified)',
      },
      analysis: {
        offensiveEdge:
          team1.latestStats?.avgGoalsFor > team2.latestStats?.avgGoalsFor
            ? team1.team.name
            : team2.team.name,
        defensiveEdge:
          team1.latestStats?.avgGoalsAgainst <
          team2.latestStats?.avgGoalsAgainst
            ? team1.team.name
            : team2.team.name,
        rankingAdvantage:
          team1.team.fifaRanking != null &&
          team2.team.fifaRanking != null &&
          team1.team.fifaRanking < team2.team.fifaRanking
            ? team1.team.name
            : team2.team.name,
      },
    };

    this.logger.log(
      `[Confrontation] Response ready for ${team1.team.name} vs ${team2.team.name}`,
    );
    return response;
  }

  private simpleMatchSimulation(team1: any, team2: any) {
    // Lógica sencilla basada solo en ranking FIFA
    const rankDiff =
      (team2.team.fifaRanking || 100) - (team1.team.fifaRanking || 100);
    const probTeam1Win = 0.5 + rankDiff / 200;
    const probTeam2Win = 0.5 - rankDiff / 200;
    const probDraw = 0.2;
    return {
      winProbability: {
        [team1.team.name]: Math.min(
          0.8,
          Math.max(0.2, probTeam1Win - probDraw / 2),
        ),
        [team2.team.name]: Math.min(
          0.8,
          Math.max(0.2, probTeam2Win - probDraw / 2),
        ),
        draw: probDraw,
      },
      expectedGoals: {
        [team1.team.name]: team1.latestStats?.avgGoalsFor || 1,
        [team2.team.name]: team2.latestStats?.avgGoalsFor || 1,
      },
    };
  }
}
