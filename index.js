const { Client } = require("@notionhq/client");
const { WebClient } = require("@slack/web-api");
const { ImgurClient } = require('imgur');
const moment = require("moment");
const ChartJSImage = require("chart.js-image");
const log = require("loglevel");
const fs = require("fs");
const core = require("@actions/core");


log.setLevel("info");
require("dotenv").config();


const parseConfig = () => {
  if (process.env.NODE_ENV === "offline") {
    return {
      notion: {
        client: new Client({ auth: process.env.NOTION_KEY }),
        databases: {
          backlog: process.env.NOTION_DB_BACKLOG,
          sprintSummary: process.env.NOTION_DB_SPRINT_SUMMARY,
          dailySummary: process.env.NOTION_DB_DAILY_SUMMARY,
        },
        options: {
          sprintProp: process.env.NOTION_PROPERTY_SPRINT,
          estimateProp: process.env.NOTION_PROPERTY_ESTIMATE,
          statusExclude: process.env.NOTION_PROPERTY_PATTERN_STATUS_EXCLUDE,
        },
      },
      chartOptions: {
        isIncludeWeekends: process.env.INCLUDE_WEEKENDS !== "false",
      },
    };
  }
  return {
    notion: {
      client: new Client({ auth: core.getInput("NOTION_KEY") }),
      databases: {
        backlog: core.getInput("NOTION_DB_BACKLOG"),
        sprintSummary: core.getInput("NOTION_DB_SPRINT_SUMMARY"),
        dailySummary: core.getInput("NOTION_DB_DAILY_SUMMARY"),
      },
      options: {
        sprintProp: core.getInput("NOTION_PROPERTY_SPRINT"),
        estimateProp: core.getInput("NOTION_PROPERTY_ESTIMATE"),
        statusExclude: core.getInput("NOTION_PROPERTY_PATTERN_STATUS_EXCLUDE"),
      },
    },
    chartOptions: {
      isIncludeWeekends: core.getInput("INCLUDE_WEEKENDS") !== "false",
    },
  };
};

const getLatestSprintSummary = async (
  notion,
  sprintSummaryDb,
  { sprintProp }
) => {
  const response = await notion.databases.query({
    database_id: sprintSummaryDb,
    sorts: [
      {
        property: sprintProp,
        direction: "descending",
      },
    ],
  });
  const { properties } = response.results[0];
  const { Sprint, Start, End , DemoDate, Goal} = properties;
  log.info(
    JSON.stringify({ message: "DemoDate:", DemoDate ,Goal})
  );
  return {
    sprint: Sprint.multi_select[0].name,
    start: moment(Start.date.start),
    end: moment(End.date.start),
    demo: moment(DemoDate.date.start).startOf("day").format("YYYY-MM-DD"),
    goal: Goal.rich_text[0].plain_text,
  };
};

const countPointsLeftInSprint = async (
  notion,
  backlogDb,
  sprint,
  { sprintProp, estimateProp, statusExclude }
) => {
  const response = await notion.databases.query({
    database_id: backlogDb,
    filter: {
      and:[
    {
      property: sprintProp,
      multi_select: {
        contains: `${sprint}`,
      },
    },
    {
      property: "Status",
      select: {
        is_not_empty: true,
      },
    },
    {
      property: "Type",
      select: {
        equals: "Story",
      },
    },]
    }
  });
  const sprintStories = response.results;
//   log.info(
//     JSON.stringify({ message: "mysprintStories:", sprintStories })
//   );
  const ongoingStories = sprintStories.filter(
    (item) =>
      !new RegExp(statusExclude).test(item.properties.Status.select.name)
  );
  let myPointLeft = ongoingStories.reduce((accum, item) => {
    if (item.properties[estimateProp]) {
      const points = item.properties[estimateProp].number;
      return accum + points;
    }
    return accum;
  }, 0);

  
  let myProgress = sprintStories.reduce(function (accum, item) {

    if (item.properties.Progress) {
      const myNumber = item.properties.Progress.formula.number;
//       log.info(
//         JSON.stringify({ item,myNumber})
//       );
      return accum + myNumber;
    }
    return accum;
  }, 0) / sprintStories.length;

  log.info(
    JSON.stringify({ myProgress})
  );
  
  return {
    pointsLeftInSprint:myPointLeft,
    progressNow:myProgress,
  }
};

const updateDailySummaryTable = async (
  notion,
  dailySummaryDb,
  sprint,
  pointsLeft,
  progressNow
) => {
  const today = moment().startOf("day").format("YYYY-MM-DD");
  const create_result = await notion.pages.create({
    parent: {
      database_id: dailySummaryDb,
    },
    properties: {
      Name: {
        title: [
          {
            text: {
              content: `${today}`,
            },
          },
        ],
      },
      Sprint: {
        multi_select:[
            {
              name: `${sprint}`
            },
        ]
      },
      Points: {
        number: pointsLeft,
      },
      Date: {
        date: { start: today, end: null },
      },
      Progress: {
        number: progressNow,
      },
    },
  });
  
  log.info(JSON.stringify({ message:"mycreate_result:",create_result }));
  
};

const isWeekend = (date) => {
  const dayOfWeek = moment(date).format("ddd");
  return dayOfWeek === "Sat" || dayOfWeek === "Sun";
};

/**
 * Calculates the number of weekdays from {@link start} to {@link end}
 * @param {moment.Moment} start First day of sprint (inclusive)
 * @param {moment.Moment} end Last day of sprint (inclusive)
 * @returns number of weekdays between both dates
 */
const getNumberOfWeekdays = (start, end) => {
  let weekdays = 0;
  for (const cur = moment(start); !cur.isAfter(end); cur.add(1, "days")) {
    if (!isWeekend(cur)) {
      weekdays += 1;
    }
  }
  return weekdays;
};

/**
 * Calculates the points left for each day of the sprint so far
 * @param {number} sprint Sprint number of current sprint
 * @param {moment.Moment} start First day of sprint (inclusive)
 * @returns {number[]} Array of points left each day from {@link start} till today (inclusive)
 * */
const getPointsLeftByDay = async (
  notion,
  dailySummaryDb,
  sprint,
  start,
  isIncludeWeekends
) => {
  log.info(JSON.stringify({ message:"enter:1"}));
  const response = await notion.databases.query({
    database_id: dailySummaryDb,
    filter: {
      property: "Sprint",
      multi_select: {
        contains: `${sprint}`,
      },
    },
    sorts: [
      {
        property: "Date",
        direction: "ascending",
      },
    ],
  });
  const pointsLeftByDay = [];
  const progressByDay = [];
  response.results.forEach((result) => {
    const { properties } = result;
    const { Date, Points ,Progress } = properties;
    const day = moment(Date.date.start).diff(start, "days");
    if (pointsLeftByDay[day]) {
      log.warn(
        JSON.stringify({
          message: "Found duplicate entry",
          date: Date.date.start,
          points: Points.number,
        })
      );
    }
    pointsLeftByDay[day] = Points.number;
    progressByDay[day] = Progress.number;
  });
  const numDaysSinceSprintStart = moment().startOf("day").diff(start, "days");
  for (let i = 0; i < numDaysSinceSprintStart; i += 1) {
    if (!pointsLeftByDay[i]) {
      pointsLeftByDay[i] = 0;
    }
    if (!progressByDay[i]) {
      progressByDay[i] = 0;
    }
  }
  log.info(JSON.stringify({ numDaysSinceSprintStart }));

  if (!isIncludeWeekends) {
    // remove weekend entries
    let index = 0;
    for (
      const cur = moment(start);
      index < pointsLeftByDay.length;
      cur.add(1, "days")
    ) {
      if (isWeekend(cur)) {
        pointsLeftByDay.splice(index, 1);
        progressByDay.splice(index, 1);
      } else {
        index += 1;
      }
    }
  }

  return {pointsLeftByDay,progressByDay};
};
/**
 * Generates the ideal burndown line for the sprint. Work is assumed to be done on
 * each weekday from {@link start} until the day before {@link end}. A data point is
 * generated for {@link end} to show the final remaining points.
 *
 * A flat line is shown across weekends if {@link isWeekendsIncluded} is set to true,
 * else, the weekends are not shown.
 * @param {moment.Moment} start The start of the sprint (inclusive)
 * @param {moment.Moment} end The end of the sprint (inclusive)
 * @param {number} initialPoints Points the sprint started with
 * @param {number} numWeekdays Number of working days in the sprint
 * @returns {number[]} Array of the ideal points left per day
 */
const getIdealBurndown = (
  start,
  end,
  initialPoints,
  numWeekdays,
  isIncludeWeekends
) => {
  const pointsPerDay = initialPoints / numWeekdays;

  log.info(
    JSON.stringify({
      initialPoints,
      numWeekdays,
      pointsPerDay,
    })
  );

  const idealBurndown = [];
  const cur = moment(start);
  const afterEnd = moment(end).add(1, "days"); // to include the end day data point
  let isPrevDayWeekday = false;
  for (let index = 0; cur.isBefore(afterEnd); index += 1, cur.add(1, "days")) {
    // if not including the weekends, just skip over the weekend days
    if (!isIncludeWeekends) {
      while (isWeekend(cur)) {
        cur.add(1, "days");
      }
    }

    if (index === 0) {
      idealBurndown[index] = initialPoints;
    } else {
      idealBurndown[index] =
        idealBurndown[index - 1] - (isPrevDayWeekday ? pointsPerDay : 0);
    }

    isPrevDayWeekday = !isWeekend(cur);
  }

  // rounds to 2 decimal places, which prevents the graph from getting jagged
  // from overtruncation when there's less than 30 points
  return idealBurndown.map((points) => +points.toFixed(2));
};

/**
 * Generates the labels for the chart from 1 to {@link numberOfDays} + 1
 * to have a data point for after the last day.
 * @param {number} numberOfDays Number of workdays in the sprint
 * @returns {number[]} Labels for the chart
 */
const getChartLabels = (numberOfDays) =>
  // cool way to generate numbers from 1 to n
  [...Array(numberOfDays).keys()].map((i) => i + 1);
/**
 * Generates the data to be displayed on the chart. Work is assumed to be
 * done on each day from the start until the day before {@link end}.
 * @param {number} sprint Current sprint number
 * @param {moment.Moment} start Start date of sprint (included)
 * @param {moment.Moment} end End date of sprint (excluded)
 * @returns The chart labels, data line, and ideal burndown line
 */
const getChartDatasets = async (
  notion,
  dailySummaryDb,
  sprint,
  start,
  end,
  { isIncludeWeekends }
) => {
  
  const numDaysInSprint = moment(end).diff(start, "days") + 1;
  const lastFullDay = moment(end).add(-1, "days");
  const numWeekdays = getNumberOfWeekdays(start, lastFullDay);

  const {pointsLeftByDay, progressByDay } = await getPointsLeftByDay(
    notion,
    dailySummaryDb,
    sprint,
    start,
    isIncludeWeekends
  );
  const idealBurndown = getIdealBurndown(
    start,
    end,
    pointsLeftByDay[0],
    numWeekdays,
    isIncludeWeekends
  );
  const labels = getChartLabels(
    isIncludeWeekends ? numDaysInSprint : numWeekdays + 1
  );

  return { labels, pointsLeftByDay, idealBurndown, progressByDay };
};

const generateChart = (data, idealBurndown, labels, demo, goal, progressByDay) => {
  const chart = ChartJSImage()
    .chart({
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Burndown",
            borderColor: "#ef4444",
            backgroundColor: "rgba(255,+99,+132,+.5)",
            data,
            yAxisID: 'y1',
          },
          {
            label: "Ideal",
            borderColor: "#cad0d6",
            backgroundColor: "rgba(54,+162,+235,+.5)",
            data: idealBurndown,
            yAxisID: 'y1',
          },
          {
            label: "Progress %",
            number:[5, 15],
            data: progressByDay,
            fill: 'origin',
            yAxisID: 'y2',
          },
        ],
      },
      options: {
        title: {
            display: true,
            text: moment().startOf("day").format("YYYY-MM-DD") + ' 燃盡圖',
        },
//         subtitle: {
//             display: true,
//             text: goal.unshift('燃盡圖','Demo:'+ demo),
//         },
        legend: {
          display: true,
          labels: {
              fontColor: 'rgb(255, 99, 132)'
          },
        },
        scales: {
          xAxes: [
            {
              scaleLabel: {
                display: true,
                labelString: "Day",
              },
            },
          ],
          yAxes: [
            {
              stacked: false,
              scaleLabel: {
                display: true,
                labelString: "Points Left",
              },
              ticks: {
                beginAtZero: true,
                max: Math.max(...data),
              },
              id: 'y1',
            },
            {
              type: 'linear',
              position: 'right',
              scaleLabel: {
                display: true,
                labelString: "Progress %",
              },
              ticks: {
                beginAtZero: true,
                max:1,
              },
              id: 'y2',
            },
          ],
        },
      },
    }) // Line chart
    .backgroundColor("white")
    .width(500) // 500px
    .height(300); // 300px
  return chart;
};

const writeChartToFile = async (chart, dir, filenamePrefix) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }
  await chart.toFile(`${dir}/${filenamePrefix}-burndown.png`);
  let chart_url = chart.toDataURI().then(chart_url => log.info(chart_url));
  chart.toDataURI().than(() => {sendImgure(chart_url);});
};

const sendSlackMessage = async (filename,demo,goal) => {
  const web = new WebClient(core.getInput("SLACK_TOKEN"));
  // The current date
  const currentTime = new Date().toTimeString();
  let image_url = `https://raw.githubusercontent.com/ezlukeyuan/notion-burndown/master/out/${filename}-burndown.png`;
  let message = JSON.stringify([{"type":"image","title":{"type":"plain_text","text":"burndown","emoji":true},"image_url":image_url,"alt_text":"marg"},
                                {"type":"section","text":{"type":"mrkdwn","text":"<"+image_url+"|this is a link>"}},
                                {"type":"section","text":{"type":"plain_text","text":filename+"\n\nDemo日："+demo+"\n\n目標：\n"+goal,"emoji":true}}]);
  log.info("message:",message);
  try {
    // Use the `chat.postMessage` method to send a message from this app
    await web.chat.postMessage({
      channel: 'C01TM4WSVH6',
//       channel: 'C0234HEGCT0',
      text:'每日Sprint目標',
      blocks: message
    });
    log.info('Message posted!');
  } catch (error) {
    log.info('error:', error);
  }
}

const sendImgure = async (filestreambase64) => {
  const imgClient = new ImgurClient({ clientId: '24326b5607ef0ce' });
  log.info('filestreambase64',filestreambase64);
  const imgResponse = await imgClient.upload([
    {
      image: filestreambase64,
      type: 'base64',
    },
  ]);
  imgResponse.data.forEach((r) => {
    log.info('r.link:', r.link);
  });
}

const run = async () => {
  const { notion, chartOptions } = parseConfig();

  const { sprint, start, end ,demo ,goal} = await getLatestSprintSummary(
    notion.client,
    notion.databases.sprintSummary,
    { sprintProp: notion.options.sprintProp }
  );
  log.info(
    JSON.stringify({ message: "Found latest sprint", sprint, start, end })
  );

  const {pointsLeftInSprint,progressNow} = await countPointsLeftInSprint(
    notion.client,
    notion.databases.backlog,
    sprint,
    {
      sprintProp: notion.options.sprintProp,
      estimateProp: notion.options.estimateProp,
      statusExclude: notion.options.statusExclude,
    }
  );
  log.info(
    JSON.stringify({
      message: "Counted points left in sprint",
      sprint,
      pointsLeftInSprint,
      progressNow,
    })
  );

  await updateDailySummaryTable(
    notion.client,
    notion.databases.dailySummary,
    sprint,
    pointsLeftInSprint,
    progressNow
  );
  log.info(
    JSON.stringify({
      message: "Updated daily summary table",
      sprint,
      pointsLeftInSprint,
      progressNow,
    })
  );

  const {
    labels,
    pointsLeftByDay: data,
    idealBurndown,
    progressByDay
  } = await getChartDatasets(
    notion.client,
    notion.databases.dailySummary,
    sprint,
    start,
    end,
    {
      isIncludeWeekends: chartOptions.isIncludeWeekends,
    }
  );
  log.info(JSON.stringify({ labels, data, idealBurndown }));
//   let mytitle = "燃盡圖|Demo日期:" + demo +"|目標:" + goal ;
  const chart = generateChart(data, idealBurndown, labels, demo, goal, progressByDay);
  let mainfilename = `sprint${sprint}-${Date.now()}`;
  await writeChartToFile(chart, "./out", mainfilename);
  await writeChartToFile(chart, "./out", `sprint${sprint}-latest`);
  log.info(
    JSON.stringify({ message: "Generated burndown chart", sprint, data })
  );
  await sendSlackMessage(`sprint${sprint}-latest`,demo,goal);

};

run();
