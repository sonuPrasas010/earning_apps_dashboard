const { Socket, Server } = require("socket.io");
// const {
//   LowCardMatchPlayer,
//   LowCardMatch,
//   LowCardMessages
// } = require("../model/config/relations");

const { MessageType, MatchResult, GameStatus, MatchEvent } = require("../model/enums");
const LowCardMatchPlayer = require("../model/databases/low_card_match_player");
const LowCardMatch = require("../model/databases/low_card_match");
const LowCardMessages = require("../model/databases/low_card_match_messages");
const User = require("../model/databases/user");
const sequelize = require("../model/config/config");
const { shuffleArray } = require("./shuffle");

// this is private function
async function checkOrChangeMatchAvability(matchId, isBotActive = false) {
  // first check if the match is in ideal state
  // if it is in ideal state then change it to starting state and return true
  // this is because to allow only first player can start game
  // once the game is started other cant start the game
  const match = await LowCardMatch.findByPk(matchId);

  if (match.getDataValue("gameStatus") === "ideal") {
    match.set("isBotActive", isBotActive);
    match.set("gameStatus", "starting");
    match.save();
    return true;
  }
  return false;
}

async function checkOrChangeStatusToPlaying(matchId, isBotActive = false) {
  // if game status is prevously starting then update and return true
  // else return false
  // false is to emmit nothing
  // true to emit message game status changed to playing
  const match = await LowCardMatch.findByPk(matchId);
 
  if (match.getDataValue("gameStatus") !== "starting") {
    return false;
  }
  match.set("isBotActive", isBotActive);
  match.set("gameStatus", "playing");
  match.save();
  return true;
}

// this is private function 

async function checkStatusToJoiningAvailability(matchId, isBotActive = false) {
  // return true if user is applcable to join
  // else return false 
  console.log(matchId);
  const match = await LowCardMatch.findByPk(matchId);
  console.log(match.getDataValue("gameStatus"));

  if (match.getDataValue("gameStatus") === "joining") {
    return true;
  }

  return false;
}

async function checkStatusToShowingAvailability(lowCardMatchPlayerId, isBotActive = false) {
  // return true if user is applcable to join
  // else return false 

  const matchPlayer = await LowCardMatchPlayer.findOne({ 
    where: { id: lowCardMatchPlayerId, is_playing: false },
    include: { model: LowCardMatch, where: { gameStatus: "playing" } } 
  });

  if (matchPlayer && matchPlayer.is_playing === true) {
    return true;
  }

  return false;
}

async function onJoinGame({ socket = new Socket(), io = new Server(), matchId, userId }) {
  const ifJoinGameAvailable = await checkStatusToJoiningAvailability(matchId);

  if (!ifJoinGameAvailable) return;
  const user = await User.findByPk(userId);
  if (user.play_point < 10) {
    const message = generateGameNotification({
      message: "Sorry! you do not have enough GP to join game",
      messageType: MessageType.BotDanger,
      user
    });
    socket.emit("roomMessage", message)
    return;
  }

  const transaction = await sequelize.transaction();
  const match = await LowCardMatch.findByPk(matchId);
  const lowCardMatchPlayer = await LowCardMatchPlayer.findOne({ where: { match_id: matchId, user_id: userId } });

  let userPp = user.getDataValue("play_point");
  userPp = userPp - 10;
  let matchPrize = match.getDataValue("prize");
  matchPrize = matchPrize + 10;

  lowCardMatchPlayer.set("is_playing", true);
  user.set("play_point", userPp);
  match.set("prize", matchPrize);
  await user.save({ transaction });
  await match.save({ transaction })
  await lowCardMatchPlayer.save({ transaction });
  await transaction.commit();
  
  const message = generateGameNotification({
    message: "joined the game",
    user: user.toJSON(),
    job: "append"
  });
  io.to(matchId).emit("roomMessage", message);
  io.to(matchId).emit("amIActive", true)
}

async function startMatch ({
  socket = new Socket(),
  io = new Server(),
  matchId
}) { 
  if (!(await checkOrChangeMatchAvability(matchId))) {
    return;
  }
      
  io.to(matchId).emit("gameStatus", "starting");

  const message = generateGameNotification({ message: "game has started" });
  io.to(matchId).emit("roomMessage", message);

  console.log("update low card match status to join");
  // const count = await LowCardMatch.update({ gameStatus: "joining" }, { where: { id: matchId } });
  // console.log(count[0]);
  const match = await LowCardMatch.findByPk(matchId);
  match.setDataValue("gameStatus", "joining");
  await match.save();
  // change match status to joining
  io.to(matchId).emit("startTime", new Date());
  io.to(matchId).emit("gameStatus", "joining");
  // pass the message to user after

  setTimeout(async () => {
    // set game status to playing after 15 sec
    // waiting is needed to shuffle

    await LowCardMatch.update({ gameStatus: "waiting" }, { where: { id: matchId } });

    io.to(matchId).emit("gameStatus", "waiting");
    const { rows, count } = await LowCardMatchPlayer.findAndCountAll({ where: { is_playing: true, match_id: matchId }, include: [LowCardMatch, User] });
    console.log(count);
    if (count < 2) {
      // if there is no more than 1 player joined game cancel the game
      for (const matchPlayer of rows) {
        console.log("hello match player");
        let playerPoint = matchPlayer.user.play_point;
        playerPoint += 10;
        console.log(playerPoint);
        await User.update({ play_point: playerPoint }, { where: { id: matchPlayer.user.id } });
        matchPlayer.set("is_playing", false);
        await matchPlayer.save();
      }
      await LowCardMatch.update({ gameStatus: "ideal", prize: 0 }, { where: { id: matchId } });
      const message = generateGameNotification({
        messageType: MessageType.BotDanger,
        message: "Nobody joined this game. Ending the match now"
      });
      io.to(matchId).emit("roomMessage", message);
      io.to(matchId).emit("gameStatus", "ideal");
      return;
    }

    const message = generateGameNotification({
      messageType: MessageType.BotInfo,
      message: `${count} players joined this game. Winner will take ${count * 10} CP.`
    });
    io.to(matchId).emit("roomMessage", message);

    await shuffleAndDistributeCard({
      io,
      socket,
      lowCardMatchId: matchId
    });

    await LowCardMatch.update({ gameStatus: "playing" }, { where: { id: matchId } })

    io.to(matchId).emit("startTime", new Date());
    io.to(matchId).emit("gameStatus", "playing");
        
    setTimeout(async() => {
      // checkWinner after the 15 second of playing time that is given to user.
      // in this time they can thow their card or eliminated. but this feature is not implemented yet
      await LowCardMatch.update({ gameStatus: "waiting" }, { where: { id: matchId } })
      io.to(matchId).emit("gameStatus", "waiting");
      const message = generateGameNotification({
        message: "Checking winner. Please wait!",
        messageType: MessageType.BotInfo
      });
      io.to(matchId).emit("roomMessage", message);
      await eliminatePassiveUser({ io, socket, lowCardMatchId: matchId });

      const result = await checkWinner(socket, io, matchId);
      if (result === MatchResult.Draw) {
        await restartDrawGame({ socket, io, matchId });
        return;
      }
      if (result === MatchResult.NextRound) {
        // 
      }
    }, 15000);
  }, 15000);
}

async function joinLowCardRoom (matchId = 0, userId, socketId) {
  console.log(`socket_id: ${socketId}`);
  const lowCardMatchPlayer = LowCardMatchPlayer.create({ match_id: matchId, user_id: userId, socket_id: socketId });
  return await lowCardMatchPlayer;
}

// start generate Game Notification function
function generateGameNotification ({
  message,
  sentBy = "bot",
  messageType = MessageType.BotSuccess,
  card,
  user = {
    name: "Bot",
    id: 1
  },
  job
}) {
  return {
    message,
    sentBy,
    messageType,
    card,
    user,
    job
  };
}

// start function checkWinner
async function checkWinner (socket = new Socket(), io = new Server(), matchId) {
  // finding count and user user playing in provided match
  let { rows, count } = await LowCardMatchPlayer.findAndCountAll({
    where: {
      match_id: matchId,
      is_playing: true,
      shown: true
    },
    include: [
      {
        model: LowCardMatch // Include the LowCardMatch association
      },
      {
        model: LowCardMessages // Include the LowCardMessages association
      },
      {
        model: User // Include the LowCardMessages association
      }
    ]
  });

  rows = rows.sort((a, b) => {
    const rankA = JSON.parse(a.low_card_match_message.card).rank;
    const rankB = JSON.parse(b.low_card_match_message.card).rank;
  
    if (rankA === 0) {
      return -1; // Move rank 0 to the beginning (highest value)
    } else if (rankB === 0) {
      return 1; // Move rank 0 to the beginning (highest value)
    } else {
      // Compare ranks normally for other values
      return rankB - rankA;
    }
  });
  
  if (count <= 5) {
    // sort it in ascending order and highest number wins if draws then restart the game
    return await chooseWinner({ totalUser: count, matchId, io, matchPlayer: rows });
  }
  const reminder = count % 5;

  if (reminder === 0) {
    // if reminder is zero then eliminate 5 user
    return await eliminateUser({ user: rows });
  }
  // if reminder is not zero then eliminate reminder's count of user
  return await eliminateUser({ numberOfUser: reminder, users: rows });
}

// this is private function
async function chooseWinner({ totalUser, matchPlayer = [], matchId, io = new Server() }) {
  if (totalUser === 0) {
    await LowCardMatch.update({ prize: 0, gameStatus: GameStatus.Ideal }, { where: { id: matchId } });
    io.to(matchId).emit("amIActive", false);
    io.to(matchId).emit("gameStatus", GameStatus.Ideal.toLowerCase());
    const message = generateGameNotification({ message: "Nobody won this round", messageType: MessageType.BotDanger });
    io.to(matchId).emit("roomMessage", message);
    return;
  }
  if (totalUser === 1) {
    const match = await LowCardMatch.findByPk(matchId);
    const winner = await User.findByPk(matchPlayer[0].user_id);
    const prize = match.getDataValue("prize");
    const userCp = winner.getDataValue("cash_point") + prize;
    match.set("gameStatus", "ideal");
    match.set("prize", 0); 
    match.set("isBotActive", false);
    await match.save()
    winner.set("cash_point", userCp);
    matchPlayer[0].set("is_playing", false);
    matchPlayer[0].set("shown", false);
    await matchPlayer[0].save();
    await winner.save();

    await LowCardMessages.destroy({ where: { match_id: matchId } });
    io.to(matchId).emit("amIActive", false);
    io.to(matchId).emit("gameStatus", GameStatus.Ideal.toLowerCase());
    const message = generateGameNotification({ message: "won this game", user: winner, job: "append" });
    io.to(matchId).emit("roomMessage", message);
    return;
  }
  const firstUserRank = JSON.parse(matchPlayer[0].low_card_match_message.card).rank;
  const secondUserRank = JSON.parse(matchPlayer[1].low_card_match_message.card).rank;
  // console.log(JSON.parse(matchPlayer[0].low_card_match_message.card));
  // console.log("first user rank"+ firstUserRank);
  // console.log("second user rank"+ secondUserRank);
  if (firstUserRank === secondUserRank) {
    return MatchResult.Draw
  }

  const transaction = await sequelize.transaction();
  const match = await LowCardMatch.findByPk(matchId, { transaction });
  const winner = await User.findByPk(matchPlayer[0].user_id, { transaction });
  const prize = match.getDataValue("prize");
  const userCp = winner.getDataValue("cash_point") + prize;
  match.set("gameStatus", "ideal");
  match.set("prize", 0); 
  match.set("isBotActive", false);
  await match.save({ transaction })
  winner.set("cash_point", userCp);
  await winner.save();

  for (const user of matchPlayer) {
    user.set("is_playing", false);
    user.set("shown", false);
    await user.save({ transaction });
  }  
  await LowCardMessages.destroy(
    { where: { match_id: matchId } });
  await transaction.commit();

  io.to(matchId).emit("gameStatus", GameStatus.Ideal.toLowerCase());
  io.to(matchId).emit("amIActive", false);
  const message = generateGameNotification({
    messageType: MessageType.WinnerAnnouncement,
    message: `Congratulation ${winner.getDataValue("name")} on wining ${prize} CP`,
    card: JSON.parse(matchPlayer[0].low_card_match_message.card),
    user: {
      name: winner.getDataValue("name"),
      id: winner.getDataValue("id")
    }
  });
  io.to(matchId).emit("roomMessage", message);

  return MatchResult.Finished;
}

// this is the private function 
async function eliminateUser({ numberOfUser = 5, users = [], io = new Server() }) {
  for (let index = 0; index < numberOfUser; index++) {
    users[index].setDataValue("is_playing", false);
    await users[index].save();
    const message = generateGameNotification({
      job: "append",
      message: "have been eliminated"
    });
    io.to(users[index].getDataValue("socket_id")).emit("roomMessage", message);
    io.to(users[index].getDataValue("socket_id")).emit("amIActive", false);
  }
  return MatchResult.NextRound;
}

async function restartDrawGame({ socket = new Socket(), io = new Server(), matchId = 0 }) { 
  await LowCardMatch.update({ gameStatus: "waiting" },
    {
      where: {
        id: matchId
      }
    });
  io.to(matchId).emit("gameStatus", "waiting")

  const message = generateGameNotification({
    message: "Please wait! Shuffling card"
  });

  io.to(matchId).emit("roomMessage", message);
  const cards = shuffleArray();

  await LowCardMessages.destroy({
    where: {
      match_id: matchId
    }
  })
  const drawedPlayers = await LowCardMatchPlayer.findAll({
    where: {
      match_id: matchId,
      isPlaying: true
    },
    include: User
  }
  );
  
  const playerCards = [];
  for (const key in drawedPlayers) {
    const data = {};
    data.card = cards[key];
    data.user_id = drawedPlayers[key].getDataValue("user_id");
    data.match_id = drawedPlayers[key].getDataValue("match_id"); 
    data.match_player_id = drawedPlayers[key].getDataValue("id");
    playerCards.push(data);

    const message = generateGameNotification({
      card: data.card,
      messageType: MessageType.CardShow,
      user: {
        name: drawedPlayers[key].user.name,
        id: drawedPlayers[key].user.id
      }
    });
    io.to(drawedPlayers[key].getDataValue("socket_id")).emit("roomMessage", message)
  }

  await LowCardMessages.bulkCreate(playerCards);
 
  await LowCardMatch.update({ gameStatus: "playing" },
    {
      where: {
        id: matchId
      }
    });

  io.to(matchId).emit("startTime", new Date());
  io.to(matchId).emit("gameStatus", "playing")

  setTimeout(async() => {
    const matchResult = await checkWinner(socket, io, matchId);
    if (matchResult === MatchResult.Draw) {
      restartDrawGame(socket, io, matchId);
    }
  }, 1500);
}

async function eliminatePassiveUser ({ io = new Server(), socket = new Socket(), lowCardMatchId }) {
  // passive users are those who did not show their card after the 20 sec of joining the game
  const { rows, count } = await LowCardMatchPlayer.findAndCountAll({ where: { match_id: lowCardMatchId, is_playing: true, shown: false }, include: User });
 
  if (count === 0) return count;

  for (const lowCardPlayer of rows) {
    lowCardPlayer.set("is_playing", false);
    lowCardPlayer.set("shown", false);
    await lowCardPlayer.save();
    await LowCardMessages.destroy({ where: { match_player_id: lowCardPlayer.getDataValue("id") } });
    const message = generateGameNotification({ message: "packed the round", messageType: MessageType.BotDanger, user: lowCardPlayer.user, job: "append" });
    io.to(lowCardMatchId).emit("roomMessage", message);
  }  

  return count;
}

async function shuffleAndDistributeCard({
  io = new Server(),
  socket = new Socket(),
  lowCardMatchId
}) {
  let message = generateGameNotification({
    message: "Shuffling cards",
    messageType: MessageType.BotSuccess
  });
  io.to(lowCardMatchId).emit("roomMessage", message);

  const shuffledCard = shuffleArray();

  // fetch all the players who have joined current room and joined the game in within 15 sec.
  const joinedPlayers = await LowCardMatchPlayer.findAll({
    include: User,
    where: {
      match_id: lowCardMatchId,
      is_playing: true
    }
  });

  const playersCards = [];
  for (let index = 0; index < joinedPlayers.length; index++) {
    const data = {};

    data.card = shuffledCard[index].toJson();
    data.user_id = joinedPlayers[index].getDataValue("user_id");
    data.match_id = lowCardMatchId;
    data.match_player_id = joinedPlayers[index].getDataValue("id");
    playersCards.push(data);

    message = generateGameNotification({
      card: data.card,
      messageType: MessageType.CardShow,
      user: joinedPlayers[index].getDataValue("user")
    });
    // emmit respective card to each player that is saved in database
    io.to(joinedPlayers[index].getDataValue("socket_id")).emit("roomMessage", message);
  }

  await LowCardMessages.bulkCreate(playersCards);

  socket.emit("room", playersCards);
  if (!(await checkOrChangeStatusToPlaying(lowCardMatchId))) {
    return;
  }
 
  socket.emit("gameStatus", "playing");
}

async function onCardShow({ socket = new Socket(), io = new Server(), userId, matchId, lowCardMatchPlayerId }) {
  if (!await checkStatusToShowingAvailability(lowCardMatchPlayerId)) {
    const message = generateGameNotification({ message: "You are not in this game", messageType: MessageType.BotDanger });
    socket.emit(MatchEvent.RoomMessage, message);
    return;
  }
  const matchPlayer = await LowCardMatchPlayer.findOne({ 
    where: { match_id: matchId, user_id: userId, is_playing: true }, 
    include: [{ model: LowCardMessages }, { model: User }] 
  });

  console.log(matchPlayer.toJSON());

  if (matchPlayer == null) {
    const message = generateGameNotification({ messageType: MessageType.BotDanger, message: "You are not in this game" });
    socket.emit(message);
    return;
  }

  matchPlayer.set("shown", true);
  await matchPlayer.save();
  const message = generateGameNotification({ card: JSON.parse(matchPlayer.low_card_match_message.card), messageType: MessageType.CardShow, user: matchPlayer.user });
  io.to(matchId).emit("roomMessage", message);
}

async function generateGameInfo(matchId) { 
  try {
    LowCardMatchPlayer.findAll()
    return await LowCardMatch.findOne(
      {
        where: { id: matchId },
        attributes: {
          include: [  
            [
              sequelize.literal(
                "(Select COUNT(*) FROM low_card_match_players WHERE low_card_match_players.match_id = low_card_match.id AND is_playing = 1)"
              ),
              "playerCount"
            ]
          ]
        },
        include: { model: LowCardMatchPlayer, where: { is_playing: true }, required: false, include: [LowCardMessages, User]/*, where: { is_playing: true } */ }
      });
  } catch (err) {
    return err;
  }
}

module.exports = { startMatch, joinLowCardRoom, checkWinner, generateGameNotification, restartDrawGame, onJoinGame, onCardShow, generateGameInfo };
